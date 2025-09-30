import { ref, computed, watch } from 'vue';

import { WorkerManager } from './WorkerManager.js';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export const state = {
  auth: ref(false),
  files: ref([]),
  fileBuffers: new Map(),
  progressHandlers: new Map(),
  workerManager: null
};

export function WM() {
  if (!state.workerManager) state.workerManager = new WorkerManager();
  return state.workerManager;
}

export const globalFileInstances = new Map();

export function useHashFS(passphrase, options = {}) {
  const loading = ref(false);
  const fileInstances = globalFileInstances;

  const vaultSizes = ref({ vaultSize: 0, vaultCompressedSize: 0 });

  const stats = computed(() => {
    const totalSize = state.files.value.reduce((sum, f) => sum + f.size, 0);
    const compressedSize = state.files.value.reduce((sum, f) => sum + f.compressedSize, 0);
    const compressionRatio = totalSize > 0 ? ((totalSize - compressedSize) / totalSize) * 100 : 0;

    return {
      fileCount: state.files.value.length,
      totalSize,
      compressedSize,
      compressionRatio,
      actualVaultSize: vaultSizes.value.vaultSize,
      actualCompressedSize: vaultSizes.value.vaultCompressedSize
    };
  });

  // Get vault sizes from worker (actual IndexedDB size vs estimated)
  async function getVaultSizes() {
    try {
      const sizes = await WM().sendToWorker('get-vault-sizes');
      return sizes || { vaultSize: 0, vaultCompressedSize: 0 };
    } catch (error) {
      console.warn('Failed to get vault sizes:', error);
      return { vaultSize: 0, vaultCompressedSize: 0 };
    }
  }

  async function init() {
    if (!String(passphrase || '').trim()) return;

    loading.value = true;
    try {
      if (state.auth.value) {
        const result = await WM().sendToWorker('init', { passphrase });
        if (!result.success) {
          throw new Error(result.error || 'Authentication failed');
        }

        if (result.messageHash.base === WM().vaultHash) {
          WM().sessionHash = result.messageHash.session;
          loading.value = false;
          return;
        }

        WM().terminate();
        state.auth.value = false;
        state.files.value = [];
        state.fileBuffers.clear();
        state.progressHandlers.clear();
        state.workerManager = null;
      }

      const result = await WM().sendToWorker('init', { passphrase });

      if (result.success) {
        state.auth.value = true;
        state.files.value = result.files || [];

        // Get actual vault sizes from worker
        try {
          const sizes = await getVaultSizes();
          vaultSizes.value = sizes;
        } catch (error) {
          console.warn('Failed to get vault sizes after init:', error);
        }
      } else {
        throw new Error(result.error || 'Authentication failed');
      }
    } catch (error) {
      throw new Error('Authentication failed: ' + error.message);
    } finally {
      loading.value = false;
    }
  }

  async function importAll(fileList, onProgress = null) {
    const operationId = 'import_' + Date.now();
    if (onProgress) state.progressHandlers.set(operationId, [onProgress]);

    try {
      const filesData = [];
      for (const file of fileList) {
        const arrayBuffer = await file.arrayBuffer();
        filesData.push({
          name: file.name,
          bytes: arrayBuffer,
          type: file.type || 'application/octet-stream'
        });
      }

      const items = await WM().sendToWorker('import-files', { files: filesData }, operationId);

      const saveResults = [];
      for (const item of items) {
        if (item.success) {
          try {
            const res = await WM().sendToWorker('save', item.data);
            if (res.success) {
              saveResults.push({ name: item.name, success: true });
              if (res.files) state.files.value = res.files;
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
      if (onProgress) state.progressHandlers.delete(operationId);
    }
  }

  async function exportZip(onProgress = null) {
    const operationId = 'exportzip_' + Date.now();

    if (onProgress) { state.progressHandlers.set(operationId, [onProgress]); }

    try {
      const zipped = await WM().sendToWorker('export-zip', { operationId });
      return zipped;
    } finally {
      if (onProgress) state.progressHandlers.delete(operationId);
    }
  }

  async function importZip(arrayBuffer, onProgress = null) {
    const operationId = 'importzip_' + Date.now();

    if (onProgress) { state.progressHandlers.set(operationId, [onProgress]); }

    try {
      const items = await WM().sendToWorker('import-zip', { arrayBuffer, operationId });

      const saveResults = [];
      for (const item of items) {
        if (item.success) {
          try {
            const res = await WM().sendToWorker('save', item.data);
            if (res.success) {
              saveResults.push({ name: item.name, success: true });
              if (res.files) state.files.value = res.files;
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
      if (onProgress) state.progressHandlers.delete(operationId);
    }
  }

  if (String(passphrase || '').trim()) {
    // Best-effort background init (no-throw)
    (async () => {
      try { await init(); } catch (e) { /* ignore */ }
    })();
  }

  function close() {
    WM()?.terminate?.();

    Object.assign(state, {
      auth: ref(false),
      files: ref([]),
      fileBuffers: new Map(),
      progressHandlers: new Map(),
      workerManager: null
    });
  }

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
    auth: state.auth,
    files: state.files,
    stats,
    loading,
    close,
    importAll,
    exportZip,
    importZip,
    downloadVault,
    getVaultSizes,
  };
}

