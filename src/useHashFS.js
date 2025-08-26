// Vue 3 Composable - HashFS with Web Workers
import { ref, computed, onBeforeUnmount } from 'vue';
import HashFSWorker from './hashfs-worker.js?worker&inline'

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Global worker instance and request tracking
let hashfsWorker = null;
let requestId = 0;
const pendingRequests = new Map();

class WorkerManager {
  constructor() {
    this.initWorker();
  }

  initWorker() {
    if (!hashfsWorker) {
      hashfsWorker = new HashFSWorker();
      hashfsWorker.onmessage = this.handleMessage.bind(this);
      hashfsWorker.onerror = error => console.error('Worker error:', error);
    }
  }

  handleMessage(e) {
    const { id, success, result, error, type, operationId } = e.data;

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
    const id = ++requestId;

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });

      // Determine transferable objects
      const transferable = [];
      if (data.bytes instanceof ArrayBuffer) transferable.push(data.bytes);
      if (data.arrayBuffer instanceof ArrayBuffer) transferable.push(data.arrayBuffer);

      hashfsWorker.postMessage({ id, type, data, operationId }, transferable);
    });
  }
}

// Global state
const globalState = {
  auth: ref(false),
  files: ref([]),
  fileBuffers: new Map(),
  progressHandlers: new Map(),
  workerManager: new WorkerManager()
};

export function useHashFS(passphrase, options = {}) {
  const loading = ref(false);
  const fileInstances = new Map();

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
    if (globalState.auth.value || !String(passphrase || '').trim()) return;

    loading.value = true;
    try {
      const result = await globalState.workerManager.sendToWorker('init', { passphrase });

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
      const items = await globalState.workerManager.sendToWorker('import-files', { files: filesData }, operationId);

      // Save all files and track results
      const saveResults = [];
      for (const item of items) {
        if (item.success) {
          try {
            const res = await globalState.workerManager.sendToWorker('save', item.data);
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
      const zipped = await globalState.workerManager.sendToWorker('export-zip', { operationId });
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
      const items = await globalState.workerManager.sendToWorker('import-zip', { arrayBuffer, operationId });

      const saveResults = [];
      for (const item of items) {
        if (item.success) {
          try {
            const res = await globalState.workerManager.sendToWorker('save', item.data);
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

  // Initialize on first call
  init();

  function close() {

    hashfsWorker?.terminate()
    hashfsWorker = null;

    Object.assign(globalState, {
      auth: ref(false),
      files: ref([]),
      fileBuffers: new Map(),
      progressHandlers: new Map(),
      workerManager: new WorkerManager()
    })
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

// File instance factory
function createFileInstance(filename, initialContent = '', fileOptions = {}) {
  if (!filename) throw new Error('Filename is required');

  const loading = ref(false);
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
    if (!globalState.auth.value) throw new Error('Not authenticated');

    // Handle initial content for new files
    if (initialContent) {
      if (typeof initialContent === 'string') {
        bytes.value = encoder.encode(initialContent);
        mime.value = fileOptions.mime || 'text/plain';
      } else {
        dirty.value = true;
      }
      return;
    }

    loading.value = true;
    try {
      const result = await globalState.workerManager.sendToWorker('load', { filename, version });

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

      const result = await globalState.workerManager.sendToWorker('save', data);

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
      const result = await globalState.workerManager.sendToWorker('rename', {
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
      const result = await globalState.workerManager.sendToWorker('delete', { filename });

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

  // Cleanup
  const cleanup = () => {
    clearTimeout(saveTimer);
  };

  if (typeof onBeforeUnmount === 'function') {
    onBeforeUnmount(cleanup);
  }

  return instance;
}