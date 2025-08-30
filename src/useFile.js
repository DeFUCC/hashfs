import { ref, computed, watch } from 'vue';
import { state, WM, encoder, decoder, globalFileInstances } from './useHashFS.js';

export function useFile(filename, initialContent = '', fileOptions = {}) {
  if (globalFileInstances.has(filename)) return globalFileInstances.get(filename);
  const inst = createFileInstance(filename, initialContent, fileOptions);
  globalFileInstances.set(filename, inst);
  return inst;
}

function createFileInstance(filename, initialContent = '', fileOptions = {}) {
  if (!filename) throw new Error('Filename is required');

  const loading = ref(true);
  const bytes = ref(new Uint8Array());
  const mime = ref('text/plain');
  const dirty = ref(false);
  const bufferKey = ref(null);
  const currentVersion = ref(0);
  const availableVersions = ref({ min: 0, max: 0 });

  const canUndo = computed(() => currentVersion.value > availableVersions.value.min);
  const canRedo = computed(() => currentVersion.value < availableVersions.value.max);

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


  const instance = { loading, filename, mime, text, bytes, dirty, currentVersion, availableVersions, canUndo, canRedo, undo, redo, load, save, rename, delete: deleteFile, import: importFile, export: exportFile };

  load().catch(console.warn);

  watch(state.auth, (val) => {
    if (val) {
      load().catch(() => { });
    } else {
      bytes.value = new Uint8Array();
      mime.value = 'text/plain';
      dirty.value = false;
      currentVersion.value = 0;
      availableVersions.value = { min: 0, max: 0 };
      if (initialContent && typeof initialContent === 'string') {
        bytes.value = encoder.encode(initialContent);
      }
    }
  });

  let saveTimer = null;
  function scheduleAutoSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), fileOptions.autoSaveDelay || 3000);
  };

  async function load(version = null) {
    if (!state.auth.value) {
      if (initialContent) {
        if (typeof initialContent === 'string') {
          bytes.value = encoder.encode(initialContent);
          mime.value = fileOptions.mime || 'text/plain';
        } else {
          dirty.value = true;
        }
        return;
      }

      if (fileOptions.passphrase) {
        try { await WM().sendToWorker('init', { passphrase: fileOptions.passphrase }); } catch (e) { }
      }
      if (!state.auth.value) return;
    }

    loading.value = true;
    try {
      const result = await WM().sendToWorker('load', { filename, version });

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
  }

  async function save() {
    if (!dirty.value || !state.auth.value) return;

    try {
      const data = { filename, mime: mime.value, bytes: bytes.value.buffer.slice() };

      const result = await WM().sendToWorker('save', data);

      if (result.success) {
        dirty.value = false;
        if (result.files) state.files.value = result.files;
        if (result.version) {
          currentVersion.value = result.version;
          const prev = availableVersions.value || { min: result.version, max: result.version };
          availableVersions.value = {
            min: prev.min || result.version,
            max: Math.max(prev.max || 0, result.version)
          };
        }
      } else { throw new Error(result.error || 'Save failed'); }

    } catch (error) {
      console.error('Save error:', error);
      throw error;
    }
  }

  async function rename(newName) {
    if (!newName || !state.auth.value) return false;

    try {
      const result = await WM().sendToWorker('rename', { oldName: filename, newName });

      if (result.success) {
        if (result.files) state.files.value = result.files;
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
    if (!state.auth.value) return;

    try {
      const result = await WM().sendToWorker('delete', { filename });

      if (result.success) {
        if (result.files) state.files.value = result.files;
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
    if (!state.auth.value) throw new Error('Not authenticated');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuffer);

      mime.value = file.type || 'application/octet-stream';
      bytes.value = fileBytes;
      dirty.value = true;

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
  }

  return instance;
}
