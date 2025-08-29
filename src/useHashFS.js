// Vue 3 Composable - HashFS with Web Workers
import { ref, computed, onBeforeUnmount, watch } from 'vue';
import HashFSWorker from './hashfs-worker.js?worker&inline'

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Global worker instance and request tracking
let hashfsWorker = null;
let requestId = 0;
const pendingRequests = new Map();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// WorkerManager lazily initializes the worker and retries on transient failures.
class WorkerManager {
  constructor() {
    // Do not initialize worker at import time (SSG-safe). Worker will be
    // created on first use via initWorker().
    this.worker = null;
    this.readyPromise = null;
    // Track vault and session identifiers without storing sensitive data
    this.vaultHash = null;     // Consistent for same vault
    this.sessionHash = null;   // Unique per session with entropy
  }

  async initWorker(retries = 3) {
    if (this.worker) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      if (typeof window === 'undefined' || typeof HashFSWorker === 'undefined') {
        throw new Error('Worker not available in this environment');
      }

      let attempt = 0;
      while (attempt < retries) {
        try {
          this.worker = new HashFSWorker();
          hashfsWorker = this.worker; // keep module-level ref for legacy code paths
          this.worker.onmessage = this.handleMessage.bind(this);
          this.worker.onerror = error => console.error('Worker error:', error);
          return;
        } catch (err) {
          attempt += 1;
          const backoff = 100 * Math.pow(2, attempt);
          await sleep(backoff);
        }
      }

      // If we reach here, initialization failed
      this.readyPromise = null;
      throw new Error('Failed to initialize HashFS worker');
    })();

    return this.readyPromise;
  }

  handleMessage(e) {
    const { id, success, result, error, type, operationId } = e.data;

    // Track vault identity and session security without storing sensitive data
    if (type === 'init' && success && result.messageHash) {
      this.vaultHash = result.messageHash.base;       // Consistent for same vault
      this.sessionHash = result.messageHash.session;  // Unique per-session
    }

    // Handle progress updates
    if (type === 'progress' && operationId) {
      const handlers = globalState.progressHandlers.get(operationId);
      if (handlers) handlers.forEach(handler => handler(e.data));
      return;
    }

    // Handle request completion
    const request = pendingRequests.get(id);
    if (request) {
      pendingRequests.delete(id);
      if (success) request.resolve(result);
      else request.reject(new Error(error));
    }
  }

  async sendToWorker(type, data = {}, operationId = null) {
    await this.initWorker();

    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });

      // Determine transferable objects
      const transferable = [];
      if (data.bytes instanceof ArrayBuffer) transferable.push(data.bytes);
      if (data.arrayBuffer instanceof ArrayBuffer) transferable.push(data.arrayBuffer);

      try {
        this.worker.postMessage({ id, type, data, operationId }, transferable);
      } catch (err) {
        pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  terminate() {
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) { /* ignore */ }
      this.worker = null;
      hashfsWorker = null;
    }
    this.readyPromise = null;
    this.vaultHash = null;
    this.sessionHash = null;
  }
}

// Global state (workerManager is created lazily to be SSG-safe)
const globalState = {
  auth: ref(false),
  files: ref([]),
  fileBuffers: new Map(),
  progressHandlers: new Map(),
  workerManager: null
};

function getWorkerManager() {
  if (!globalState.workerManager) globalState.workerManager = new WorkerManager();
  return globalState.workerManager;
}

// Shared file instance cache so `useHashFS().useFile()` and `useFile()` return
// the same reactive instance for a given filename.
const globalFileInstances = new Map();

export function useHashFS(passphrase, options = {}) {
  const loading = ref(false);
  const fileInstances = globalFileInstances;

  // Computed stats
  const stats = computed(() => {
    const totalSize = globalState.files.value.reduce((sum, f) => sum + f.size, 0);
    const compressedSize = globalState.files.value.reduce((sum, f) => sum + f.compressedSize, 0);
    const compressionRatio = totalSize > 0 ? ((totalSize - compressedSize) / totalSize) * 100 : 0;

    return {
      fileCount: globalState.files.value.length,
      totalSize,
      compressedSize,
      compressionRatio,
      estimatedDbSize: compressedSize * 1.3
    };
  });

  // Initialize
  async function init() {
    if (!String(passphrase || '').trim()) return;

    loading.value = true;
    try {
      const wm = getWorkerManager();

      // If already logged in, check if this is a different passphrase
      if (globalState.auth.value) {
        // Try init with new passphrase - if messageHash changes, it's a different vault
        const result = await wm.sendToWorker('init', { passphrase });
        if (!result.success) {
          throw new Error(result.error || 'Authentication failed');
        }

        if (result.messageHash.base === wm.vaultHash) {
          // Same vault, update session hash and continue
          wm.sessionHash = result.messageHash.session;
          loading.value = false;
          return;
        }

        // Different vault detected - reset state securely
        wm.terminate();
        globalState.auth.value = false;
        globalState.files.value = [];
        globalState.fileBuffers.clear();
        globalState.progressHandlers.clear();
        globalState.workerManager = null;
      }

      // Fresh init with new worker
      const wm2 = getWorkerManager();
      const result = await wm2.sendToWorker('init', { passphrase });

      if (result.success) {
        globalState.auth.value = true;
        globalState.files.value = result.files || [];
      } else {
        throw new Error(result.error || 'Authentication failed');
      }
    } catch (error) {
      throw new Error('Authentication failed: ' + error.message);
    } finally {
      loading.value = false;
    }
  }

  // Import multiple files
  async function importAll(fileList, onProgress = null) {
    const operationId = 'import_' + Date.now();
    if (onProgress) globalState.progressHandlers.set(operationId, [onProgress]);

    try {
      // Convert FileList to array of { name, bytes, type }
      const filesData = [];
      for (const file of fileList) {
        const arrayBuffer = await file.arrayBuffer();
        filesData.push({
          name: file.name,
          bytes: arrayBuffer,
          type: file.type || 'application/octet-stream'
        });
      }

      // Process all files in the worker
      const items = await getWorkerManager().sendToWorker('import-files', { files: filesData }, operationId);

      // Save all files and track results
      const saveResults = [];
      for (const item of items) {
        if (item.success) {
          try {
            const res = await getWorkerManager().sendToWorker('save', item.data);
            if (res.success) {
              saveResults.push({ name: item.name, success: true });
              if (res.files) globalState.files.value = res.files;
            } else {
              saveResults.push({ name: item.name, success: false, error: res.error });
            }
          } catch (err) {
            saveResults.push({ name: item.name, success: false, error: err.message });
          }
        } else {
          saveResults.push(item);
        }
      }

      return saveResults;
    } finally {
      if (onProgress) globalState.progressHandlers.delete(operationId);
    }
  }


  // Export entire vault as a ZIP (returns Uint8Array)
  async function exportZip(onProgress = null) {
    const operationId = 'exportzip_' + Date.now();

    if (onProgress) {
      globalState.progressHandlers.set(operationId, [onProgress]);
    }

    try {
      const zipped = await getWorkerManager().sendToWorker('export-zip', { operationId });
      // zipped is a Uint8Array (transfered)
      return zipped;
    } finally {
      if (onProgress) globalState.progressHandlers.delete(operationId);
    }
  }

  // Import a ZIP ArrayBuffer and write files into the vault. Returns per-file results.
  async function importZip(arrayBuffer, onProgress = null) {
    const operationId = 'importzip_' + Date.now();

    if (onProgress) {
      globalState.progressHandlers.set(operationId, [onProgress]);
    }

    try {
      // Send zip to worker; worker will return an array of items with transferable bytes
      const items = await getWorkerManager().sendToWorker('import-zip', { arrayBuffer, operationId });

      const saveResults = [];
      for (const item of items) {
        if (item.success) {
          try {
            const res = await getWorkerManager().sendToWorker('save', item.data);
            if (res.success) {
              saveResults.push({ name: item.name, success: true });
              if (res.files) globalState.files.value = res.files;
            } else {
              saveResults.push({ name: item.name, success: false, error: res.error });
            }
          } catch (err) {
            saveResults.push({ name: item.name, success: false, error: err.message });
          }
        } else {
          saveResults.push(item);
        }
      }

      return saveResults;
    } finally {
      if (onProgress) globalState.progressHandlers.delete(operationId);
    }
  }

  // Do not auto-init here; let consumer call init. However, if a passphrase was
  // provided, attempt a best-effort init but do not throw if environment isn't ready.
  if (String(passphrase || '').trim()) {
    // Best-effort background init (no-throw)
    (async () => {
      try { await init(); } catch (e) { /* ignore */ }
    })();
  }

  function close() {
    getWorkerManager()?.terminate?.();

    Object.assign(globalState, {
      auth: ref(false),
      files: ref([]),
      fileBuffers: new Map(),
      progressHandlers: new Map(),
      workerManager: null
    });
  }

  // UI helper to safely trigger zip download with progress
  async function downloadVault(filename = 'vault.zip', onProgress = null) {
    try {
      const zipped = await exportZip(onProgress);
      const blob = new Blob([zipped], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    } catch (error) {
      console.error('Download failed:', error);
      return false;
    }
  }

  return {
    auth: globalState.auth,
    files: globalState.files,
    stats,
    loading,
    close,
    importAll,
    exportZip,
    importZip,
    downloadVault,
    useFile: (filename, initialContent, fileOptions) => {
      // Return a cached instance per filename so UI bindings reference a stable object
      if (fileInstances.has(filename)) return fileInstances.get(filename);
      const inst = createFileInstance(filename, initialContent, fileOptions);
      fileInstances.set(filename, inst);
      return inst;
    }
  };
}

// Export a standalone useFile composable that uses the same global state.
export function useFile(filename, initialContent = '', fileOptions = {}) {
  if (globalFileInstances.has(filename)) return globalFileInstances.get(filename);
  const inst = createFileInstance(filename, initialContent, fileOptions);
  globalFileInstances.set(filename, inst);
  return inst;
}

// File instance factory
function createFileInstance(filename, initialContent = '', fileOptions = {}) {
  if (!filename) throw new Error('Filename is required');

  const loading = ref(true);
  const bytes = ref(new Uint8Array());
  const mime = ref('text/plain');
  const dirty = ref(false);
  const bufferKey = ref(null);

  // Version control state
  const currentVersion = ref(0);
  const availableVersions = ref({ min: 0, max: 0 });
  const canUndo = computed(() => currentVersion.value > availableVersions.value.min);
  const canRedo = computed(() => currentVersion.value < availableVersions.value.max);

  let saveTimer = null;
  const scheduleAutoSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), fileOptions.autoSaveDelay || 1800);
  };

  // Reactive text content
  const text = computed({
    get: () => {
      if (bytes.value.length > 5 * 1024 * 1024) return '';
      try {
        return decoder.decode(bytes.value);
      } catch {
        return '';
      }
    },
    set: (value) => {
      const newBytes = encoder.encode(value || '');
      bytes.value = newBytes;
      dirty.value = true;

      if (fileOptions.autoSave !== false) scheduleAutoSave();
    }
  });

  async function load(version = null) {
    // If we are not authenticated yet, respect initialContent and optionally
    // attempt a best-effort init if a passphrase was provided in fileOptions.
    if (!globalState.auth.value) {
      if (initialContent) {
        if (typeof initialContent === 'string') {
          bytes.value = encoder.encode(initialContent);
          mime.value = fileOptions.mime || 'text/plain';
        } else {
          dirty.value = true;
        }
        return;
      }

      // Try to auto-init with provided passphrase, otherwise wait for explicit init
      if (fileOptions.passphrase) {
        try {
          await getWorkerManager().sendToWorker('init', { passphrase: fileOptions.passphrase });
          // If init succeeded the global auth will be updated by the caller of init()
        } catch (e) {
          // ignore init failures here; caller can init later
        }
      }

      // Still not authenticated -> defer load
      if (!globalState.auth.value) return;
    }

    // Authenticated: perform load
    loading.value = true;
    try {
      const result = await getWorkerManager().sendToWorker('load', { filename, version });

      if (result.bytes) {
        bytes.value = new Uint8Array(result.bytes);
        mime.value = result.mime || 'application/octet-stream';
        currentVersion.value = result.version;
        availableVersions.value = result.availableVersions;
      }
      dirty.value = false;

    } catch (error) {
      console.error('Load error:', error);
      throw error;
    } finally {
      loading.value = false;
    }
  }

  async function undo() {
    if (!canUndo.value) return;
    await load(currentVersion.value - 1);
  }

  async function redo() {
    if (!canRedo.value) return;
    await load(currentVersion.value + 1);
  } async function save() {
    if (!dirty.value || !globalState.auth.value) return;

    try {
      const data = {
        filename,
        mime: mime.value,
        bytes: bytes.value.buffer.slice() // Transfer ArrayBuffer
      };

      const result = await getWorkerManager().sendToWorker('save', data);

      if (result.success) {
        dirty.value = false;
        if (result.files) globalState.files.value = result.files;
        // Update version info immediately so UI reflects new head version
        if (result.version) {
          currentVersion.value = result.version;
          const prev = availableVersions.value || { min: result.version, max: result.version };
          availableVersions.value = {
            min: prev.min || result.version,
            max: Math.max(prev.max || 0, result.version)
          };
        }
      } else {
        throw new Error(result.error || 'Save failed');
      }

    } catch (error) {
      console.error('Save error:', error);
      throw error;
    }
  }

  async function rename(newName) {
    if (!newName || !globalState.auth.value) return false;

    try {
      const result = await getWorkerManager().sendToWorker('rename', {
        oldName: filename,
        newName
      });

      if (result.success) {
        if (result.files) globalState.files.value = result.files;
        Object.defineProperty(instance, 'filename', { value: newName, writable: false });
        return true;
      }

      return false;
    } catch (error) {
      console.error('Rename error:', error);
      return false;
    }
  }

  async function deleteFile() {
    if (!globalState.auth.value) return;

    try {
      const result = await getWorkerManager().sendToWorker('delete', { filename });

      if (result.success) {
        if (result.files) globalState.files.value = result.files;
        // Clear local state
        bytes.value = new Uint8Array();
        dirty.value = false;
      } else {
        throw new Error(result.error || 'Delete failed');
      }

    } catch (error) {
      console.error('Delete error:', error);
      throw error;
    }
  }

  async function importFile(file) {
    if (!globalState.auth.value) throw new Error('Not authenticated');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuffer);

      mime.value = file.type || 'application/octet-stream';
      bytes.value = fileBytes;
      dirty.value = true;

      // Auto-save imported files
      await save();

    } catch (error) {
      console.error('Import error:', error);
      throw new Error(`Import failed: ${error.message}`);
    }
  }

  function exportFile() {
    const blob = new Blob([bytes.value], { type: mime.value });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const instance = {
    loading,
    filename,
    mime,
    text,
    bytes,
    dirty,
    // Version control
    currentVersion,
    availableVersions,
    canUndo,
    canRedo,
    undo,
    redo,
    // File operations
    load,
    save,
    rename,
    delete: deleteFile,
    import: importFile,
    export: exportFile
  };

  // Auto-load on creation
  load().catch(console.warn);
  // Cleanup function for timers
  const cleanup = () => {
    clearTimeout(saveTimer);
  };

  // Watch auth changes to handle login/logout/relogin securely
  const stopWatch = watch(globalState.auth, (val) => {
    if (val) {
      // On login/relogin: attempt to load content from new vault
      load().catch(() => { });
    } else {
      // On logout or vault change: clear sensitive content
      bytes.value = new Uint8Array();
      mime.value = 'text/plain';
      dirty.value = false;
      currentVersion.value = 0;
      availableVersions.value = { min: 0, max: 0 };
      // If initialContent was provided, restore it
      if (initialContent && typeof initialContent === 'string') {
        bytes.value = encoder.encode(initialContent);
      }
    }
  });

  // cleanup watch on unmount
  const cleanupWithWatch = () => {
    try { stopWatch(); } catch (e) { /* ignore */ }
    cleanup();
  };

  if (typeof onBeforeUnmount === 'function') {
    onBeforeUnmount(cleanupWithWatch);
  }

  return instance;
}