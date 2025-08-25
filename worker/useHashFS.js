// useHashFS.js - Main thread composable for encrypted file storage
import { ref, computed, reactive, onBeforeUnmount } from 'vue';
import StorageWorker from './storage-worker.js?worker&inline'

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function useHashFS() {
  // State
  const auth = ref(false);
  const loading = ref(false);
  const files = reactive([]);

  // Worker management
  let worker = null;
  let messageId = 0;
  const pendingMessages = new Map();
  const fileBuffers = new Map(); // filename -> SharedArrayBuffer info

  // Initialize worker
  function initWorker() {
    if (worker) return;

    worker = new StorageWorker()

    worker.onmessage = (e) => {
      const { id, success, error, sab, ...data } = e.data;
      const resolve = pendingMessages.get(id);
      if (resolve) {
        pendingMessages.delete(id);
        if (success) resolve({ success: true, ...data });
        else resolve({ success: false, error });
      }
    };

    worker.onerror = (error) => {
      console.error('Worker error:', error);
      pendingMessages.forEach(resolve =>
        resolve({ success: false, error: 'Worker error' })
      );
      pendingMessages.clear();
    };
  }

  // Send message to worker
  function sendMessage(type, data = {}) {
    return new Promise((resolve) => {
      initWorker();
      const id = ++messageId;
      pendingMessages.set(id, resolve);
      worker.postMessage({ id, type, data });
    });
  }

  // Login function
  async function login(passphrase) {
    if (!passphrase?.trim()) throw new Error('Passphrase required');

    loading.value = true;
    try {
      const result = await sendMessage('login', { passphrase });
      if (result.success) {
        auth.value = true;
        await refreshFilesList();
      } else {
        throw new Error(result.error);
      }
    } finally {
      loading.value = false;
    }
  }

  // Refresh files list
  async function refreshFilesList() {
    const result = await sendMessage('getFilesList');
    if (result.success) {
      files.splice(0, files.length, ...result.files);
    }
  }

  // Export all files
  async function exportAll() {
    const exported = {};

    for (const file of files) {
      const result = await sendMessage('loadFile', { name: file.name });
      if (result.success && result.content) {
        exported[file.name] = {
          mime: result.mime,
          content: new Uint8Array(result.content)
        };
      }
    }

    return exported;
  }

  // File-specific composable
  function useFile(name) {
    // File state
    const fileName = ref(name);
    const mime = ref('text/plain');
    const bytes = ref(new Uint8Array());
    const isDirty = ref(false);
    const isLoading = ref(false);

    let buffer = null;
    let saveTimeout = null;

    // Computed text content
    const text = computed({
      get: () => {
        try { return decoder.decode(bytes.value); }
        catch { return ''; }
      },
      set: (value) => {
        bytes.value = encoder.encode(value || '');
        isDirty.value = true;
        scheduleSave();
      }
    });

    // Auto-save scheduling
    function scheduleSave() {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(save, 800);
    }

    // Load file content
    async function load() {
      if (!auth.value || !fileName.value) return;

      isLoading.value = true;
      try {
        // Create shared buffer for large files
        const maxSize = 10 * 1024 * 1024; // 10MB
        const bufferId = `file-${fileName.value}-${Date.now()}`;

        const bufferResult = await sendMessage('registerBuffer', {
          bufferId,
          size: maxSize
        });

        if (bufferResult.success && bufferResult.sab) {
          buffer = {
            id: bufferId,
            sab: bufferResult.sab,
            view: new DataView(bufferResult.sab),
            bytes: new Uint8Array(bufferResult.sab, 8)
          };
        }

        const result = await sendMessage('loadFile', {
          name: fileName.value,
          bufferId: buffer?.id
        });

        if (result.success) {
          if (result.shared && buffer) {
            // Read from shared buffer
            const len = buffer.view.getUint32(0);
            bytes.value = new Uint8Array(buffer.bytes.slice(0, len));
          } else if (result.content) {
            // Direct transfer
            bytes.value = new Uint8Array(result.content);
          }

          mime.value = result.mime || 'text/plain';
          isDirty.value = false;
        } else if (result.error === 'File not found') {
          // New file
          bytes.value = encoder.encode(`# ${fileName.value}\n\nStart editing...`);
          mime.value = 'text/markdown';
          isDirty.value = true;
        } else {
          throw new Error(result.error);
        }
      } finally {
        isLoading.value = false;
      }
    }

    // Save file
    async function save() {
      if (!isDirty.value || !fileName.value) return;

      clearTimeout(saveTimeout);

      try {
        let saveData = {};

        if (buffer && bytes.value.length <= buffer.bytes.length) {
          // Use shared buffer
          const len = Math.min(bytes.value.length, buffer.bytes.length);
          buffer.bytes.set(bytes.value.subarray(0, len));
          buffer.view.setUint32(0, len);
          saveData = {
            name: fileName.value,
            mime: mime.value,
            bufferId: buffer.id
          };
        } else {
          // Direct transfer
          saveData = {
            name: fileName.value,
            content: Array.from(bytes.value),
            mime: mime.value
          };
        }

        const result = await sendMessage('saveFile', saveData);

        if (result.success && !result.unchanged) {
          isDirty.value = false;
          await refreshFilesList();
        }
      } catch (error) {
        console.error('Save failed:', error);
      }
    }

    // Create new file
    async function newFile(newName) {
      const targetName = newName || fileName.value;
      if (!targetName) throw new Error('File name required');

      fileName.value = targetName;
      bytes.value = encoder.encode(`# ${targetName}\n\nStart editing...`);
      mime.value = 'text/markdown';
      isDirty.value = true;

      return true;
    }

    // Delete file
    async function deleteFile() {
      if (!fileName.value) return false;

      const result = await sendMessage('deleteFile', { name: fileName.value });
      if (result.success) {
        await refreshFilesList();
        // Clear current content
        fileName.value = '';
        bytes.value = new Uint8Array();
        isDirty.value = false;
        return true;
      }
      return false;
    }

    // Rename file
    async function rename(newName) {
      if (!fileName.value || !newName) return false;

      const result = await sendMessage('renameFile', {
        oldName: fileName.value,
        newName
      });

      if (result.success) {
        fileName.value = newName;
        await refreshFilesList();
        return true;
      }
      return false;
    }

    // Import file
    async function importFile(file) {
      if (!file) return false;

      fileName.value = file.name;
      mime.value = file.type || 'application/octet-stream';
      bytes.value = new Uint8Array(await file.arrayBuffer());
      isDirty.value = true;

      return true;
    }

    // Export file
    function exportFile() {
      if (!fileName.value) return;

      const blob = new Blob([bytes.value], { type: mime.value });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName.value;
      a.click();
      URL.revokeObjectURL(url);
    }

    // Load on first access if name provided
    if (name) {
      load();
    }

    // Cleanup
    onBeforeUnmount(() => {
      clearTimeout(saveTimeout);
      if (buffer) {
        sendMessage('unregisterBuffer', { bufferId: buffer.id });
      }
    });

    return {
      name: fileName,
      mime,
      text,
      bytes: computed(() => bytes.value),
      isDirty,
      isLoading,
      load,
      save,
      new: newFile,
      delete: deleteFile,
      rename,
      import: importFile,
      export: exportFile
    };
  }

  // Computed files list
  const filesList = computed(() => files);

  // Cleanup
  onBeforeUnmount(() => {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    fileBuffers.clear();
    pendingMessages.clear();
  });

  return {
    login,
    auth,
    loading,
    filesList,
    useFile,
    exportAll
  };
}