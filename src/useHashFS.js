// Vue 3 Composable - HashFS with Web Workers
import { ref, computed, onBeforeUnmount } from 'vue';
import HashFSWorker from './hashfs-worker.js?worker&inline'
import BulkWorker from './bulk-worker.js?worker&inline'


const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Global worker instances
let hashfsWorker = null;
let bulkWorker = null;

// Request ID counter
let requestId = 0;

// Pending requests
const pendingRequests = new Map();

class WorkerManager {
  constructor() {
    this.initWorkers();
  }

  initWorkers() {
    if (!hashfsWorker) {
      hashfsWorker = new HashFSWorker();
      hashfsWorker.onmessage = this.handleHashfsMessage.bind(this);
      hashfsWorker.onerror = this.handleWorkerError.bind(this);
    }

    if (!bulkWorker) {
      bulkWorker = new BulkWorker();
      bulkWorker.onmessage = this.handleBulkMessage.bind(this);
      bulkWorker.onerror = this.handleWorkerError.bind(this);
    }
  }

  handleHashfsMessage(e) {
    const { id, success, result, error } = e.data;
    const request = pendingRequests.get(id);

    if (request) {
      pendingRequests.delete(id);

      if (success) {
        request.resolve(result);
      } else {
        request.reject(new Error(error));
      }
    }
  }

  handleBulkMessage(e) {
    const { id, success, result, error, type, operationId } = e.data;

    if (type === 'progress') {
      // Handle progress updates
      const progressHandlers = globalState.progressHandlers.get(operationId);
      if (progressHandlers) {
        progressHandlers.forEach(handler => handler(e.data));
      }
      return;
    }

    const request = pendingRequests.get(id);
    if (request) {
      pendingRequests.delete(id);

      if (success) {
        request.resolve(result);
      } else {
        request.reject(new Error(error));
      }
    }
  }

  handleWorkerError(e) {
    console.error('Worker error:', e);
  }

  async sendToHashfsWorker(type, data = {}) {
    const id = ++requestId;

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });

      // Determine transferable objects
      const transferable = [];
      if (data.bytes instanceof ArrayBuffer) {
        transferable.push(data.bytes);
      }

      hashfsWorker.postMessage({ id, type, data }, transferable);
    });
  }

  async sendToBulkWorker(type, data = {}, operationId = null) {
    const id = ++requestId;

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });

      const transferable = [];
      if (data.arrayBuffer instanceof ArrayBuffer) {
        transferable.push(data.arrayBuffer);
      }

      bulkWorker.postMessage({ id, type, data, operationId }, transferable);
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
      const result = await globalState.workerManager.sendToHashfsWorker('init', { passphrase });

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

  // Bulk import
  async function importAll(fileList, onProgress = null) {
    const operationId = 'import_' + Date.now();

    if (onProgress) {
      globalState.progressHandlers.set(operationId, [onProgress]);
    }

    try {
      // Process files in bulk worker
      const bulkResults = await globalState.workerManager.sendToBulkWorker(
        'import',
        { files: Array.from(fileList) },
        operationId
      );

      // Save each file through main worker
      const saveResults = [];
      for (const item of bulkResults) {
        if (item.success) {
          try {
            const saveResult = await globalState.workerManager.sendToHashfsWorker(
              'save',
              item.data
            );

            if (saveResult.success) {
              saveResults.push({ name: item.name, success: true });
              // Update file list
              if (saveResult.files) {
                globalState.files.value = saveResult.files;
              }
            } else {
              saveResults.push({
                name: item.name,
                success: false,
                error: saveResult.error
              });
            }
          } catch (error) {
            saveResults.push({
              name: item.name,
              success: false,
              error: error.message
            });
          }
        } else {
          saveResults.push(item);
        }
      }

      return saveResults;

    } finally {
      if (onProgress) {
        globalState.progressHandlers.delete(operationId);
      }
    }
  }

  // Bulk export
  async function exportAll(onProgress = null) {
    const operationId = 'export_' + Date.now();

    if (onProgress) {
      globalState.progressHandlers.set(operationId, [onProgress]);
    }

    try {
      // Get all file data from main worker
      const exportData = await globalState.workerManager.sendToHashfsWorker('export-all');

      // Process through bulk worker for efficient handling
      const processed = await globalState.workerManager.sendToBulkWorker(
        'export',
        { fileData: exportData },
        operationId
      );

      return processed;

    } finally {
      if (onProgress) {
        globalState.progressHandlers.delete(operationId);
      }
    }
  }

  // Initialize on first call
  init();

  function close() {

    hashfsWorker?.terminate()
    hashfsWorker = null;
    bulkWorker?.terminate()
    bulkWorker = null;

    Object.assign(globalState, {
      auth: ref(false),
      files: ref([]),
      fileBuffers: new Map(),
      progressHandlers: new Map(),
      workerManager: new WorkerManager()
    })
  }

  return {
    auth: globalState.auth,
    files: globalState.files,
    stats,
    loading,
    close,
    importAll,
    exportAll,
    useFile: (filename, initialContent, fileOptions) =>
      createFileInstance(filename, initialContent, fileOptions, fileInstances)
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

  let saveTimer = null;
  const scheduleAutoSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), fileOptions.autoSaveDelay || 800);
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

  async function load() {
    if (!globalState.auth.value) throw new Error('Not authenticated');

    // Handle initial content for new files
    if (initialContent) {
      if (typeof initialContent === 'string') {
        bytes.value = encoder.encode(initialContent);
        mime.value = fileOptions.mime || 'text/plain';
      } else if (initialContent instanceof Uint8Array) {
        bytes.value = initialContent;
        mime.value = fileOptions.mime || 'application/octet-stream';
      }
      dirty.value = true;
      return;
    }

    loading.value = true;
    try {
      const result = await globalState.workerManager.sendToHashfsWorker('load', { filename });

      if (result.bytes) {
        bytes.value = new Uint8Array(result.bytes);
      }

      mime.value = result.mime || 'application/octet-stream';
      dirty.value = false;

    } catch (error) {
      console.error('Load error:', error);
      throw error;
    } finally {
      loading.value = false;
    }
  }

  async function save() {
    if (!dirty.value || !globalState.auth.value) return;

    try {
      const data = {
        filename,
        mime: mime.value,
        bytes: bytes.value.buffer.slice() // Transfer ArrayBuffer
      };

      const result = await globalState.workerManager.sendToHashfsWorker('save', data);

      if (result.success) {
        dirty.value = false;

        // Update file list
        if (result.files) {
          globalState.files.value = result.files;
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
      const result = await globalState.workerManager.sendToHashfsWorker('rename', {
        oldName: filename,
        newName
      });

      if (result.success) {
        // Update file list
        if (result.files) {
          globalState.files.value = result.files;
        }

        // Update internal filename reference
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
      const result = await globalState.workerManager.sendToHashfsWorker('delete', { filename });

      if (result.success) {
        // Update file list
        if (result.files) {
          globalState.files.value = result.files;
        }

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