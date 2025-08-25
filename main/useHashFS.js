import { ref, computed, reactive, onBeforeUnmount } from 'vue';
import { openDB } from 'idb';
import { cryptoUtils, compress, createChainManager } from './crypto.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Global state for the filesystem
const globalState = {
  auth: ref(false),
  keys: ref(null),
  db: ref(null),
  chainManager: ref(null),
  metadata: reactive({ files: {} })
};

export function useHashFS(passphrase, options = {}) {
  const loading = ref(false);
  const fileInstances = new Map(); // Track active file instances

  // Computed stats
  const files = computed(() =>
    Object.entries(globalState.metadata.files).map(([name, meta]) => ({
      name,
      mime: meta.mime || 'text/plain',
      versions: meta.headVersion || 0,
      size: meta.lastSize || 0,
      compressedSize: meta.lastCompressedSize || 0,
      modified: meta.lastModified || 0
    })).sort((a, b) => a.name.localeCompare(b.name))
  );

  const stats = computed(() => {
    const totalSize = files.value.reduce((sum, f) => sum + f.size, 0);
    const compressedSize = files.value.reduce((sum, f) => sum + f.compressedSize, 0);
    const compressionRatio = totalSize > 0 ? ((totalSize - compressedSize) / totalSize) * 100 : 0;

    return {
      fileCount: files.value.length,
      totalSize,
      compressedSize,
      compressionRatio,
      estimatedDbSize: compressedSize * 1.3 // ~30% overhead estimate
    };
  });

  // Initialize the filesystem
  async function init() {
    if (globalState.auth.value || !String(passphrase || '').trim()) return;

    loading.value = true;
    try {
      globalState.keys.value = await cryptoUtils.deriveKeys(passphrase);

      globalState.db.value = await openDB(globalState.keys.value.dbName, 1, {
        upgrade(database) {
          if (!database.objectStoreNames.contains('files')) database.createObjectStore('files');
          if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta');
          if (!database.objectStoreNames.contains('chains')) database.createObjectStore('chains');
        }
      });

      globalState.chainManager.value = createChainManager(
        globalState.db.value,
        globalState.keys.value.encKey
      );

      // Load metadata
      try {
        const encrypted = await globalState.db.value.get('meta', 'index');
        if (encrypted) {
          const decrypted = await cryptoUtils.decrypt(encrypted, globalState.keys.value.encKey);
          const data = JSON.parse(decoder.decode(decrypted));
          Object.assign(globalState.metadata.files, data.files || {});
        }
      } catch (e) {
        console.warn('Metadata load failed:', e);
      }

      await cleanup();
      globalState.auth.value = true;

    } catch (e) {
      throw new Error('Authentication failed: ' + e.message);
    } finally {
      loading.value = false;
    }
  }

  async function cleanup() {
    const referenced = new Set();
    const ghostFiles = [];

    for (const [fileName, meta] of Object.entries(globalState.metadata.files)) {
      let hasValidContent = false;

      if (meta.chainId) {
        try {
          const chain = await globalState.chainManager.value.getChain(meta.chainId);
          chain.versions.forEach(v => {
            if (v.key) {
              referenced.add(v.key);
              hasValidContent = true;
            }
          });
        } catch (error) {
          console.warn(`Failed to load chain for ${fileName}:`, error);
        }
      }

      if (meta.activeKey) {
        try {
          const exists = await globalState.db.value.get('files', meta.activeKey);
          if (exists) {
            referenced.add(meta.activeKey);
            hasValidContent = true;
          }
        } catch (error) {
          console.warn(`Error checking activeKey for ${fileName}:`, error);
        }
      }

      if (!hasValidContent && (meta.activeKey || meta.headVersion > 0)) {
        ghostFiles.push(fileName);
      }
    }

    if (ghostFiles.length > 0) {
      ghostFiles.forEach(name => delete globalState.metadata.files[name]);
      await saveMetadata();
    }

    const allKeys = await globalState.db.value.getAllKeys('files');
    const orphaned = allKeys.filter(key => !referenced.has(key));

    if (orphaned.length > 0) {
      const tx = globalState.db.value.transaction(['files'], 'readwrite');
      for (const key of orphaned) {
        try { await tx.objectStore('files').delete(key); }
        catch (e) { console.warn('Cleanup failed for:', key, e); }
      }
      await tx.done;
    }
  }

  async function saveMetadata() {
    const data = { files: globalState.metadata.files, schemaVersion: 5 };
    const bytes = encoder.encode(JSON.stringify(data));
    const encrypted = await cryptoUtils.encrypt(bytes, globalState.keys.value.encKey);
    await globalState.db.value.put('meta', encrypted, 'index');
  }

  async function importAll(fileList) {
    const results = [];
    for (const file of fileList) {
      try {
        const fileInstance = createFileInstance(file.name, null, undefined, fileInstances)
        await fileInstance.import(file);
        results.push({ name: file.name, success: true });
      } catch (error) {
        console.error(`Import failed for ${file.name}:`, error);
        results.push({ name: file.name, success: false, error: error.message });
      }
    }
    return results;
  }

  async function exportAll() {
    const exported = {};
    for (const [name, meta] of Object.entries(globalState.metadata.files)) {
      if (meta.activeKey) {
        try {
          const encrypted = await globalState.db.value.get('files', meta.activeKey);
          const decrypted = await cryptoUtils.decrypt(encrypted, globalState.keys.value.encKey);
          const content = await compress.inflate(decrypted);
          exported[name] = {
            mime: meta.mime,
            content: Array.from(content)
          };
        } catch (e) {
          console.warn(`Export failed for ${name}:`, e);
        }
      }
    }
    return exported;
  }

  // Initialize on first call
  init();

  return {
    auth: globalState.auth,
    files,
    stats,
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

  let saveTimer = null;
  const scheduleAutoSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), fileOptions.autoSaveDelay || 800);
  };

  // Reactive text content (for text files under 5MB)
  const text = computed({
    get: () => {
      if (bytes.value.length > 5 * 1024 * 1024) return ''; // 5MB limit
      try { return decoder.decode(bytes.value); }
      catch { return ''; }
    },
    set: (value) => {
      bytes.value = encoder.encode(value || '');
      dirty.value = true;
      if (fileOptions.autoSave !== false) scheduleAutoSave();
    }
  });

  async function load() {
    if (!globalState.auth.value) throw new Error('Not authenticated');

    const meta = globalState.metadata.files[filename];
    if (!meta) {
      // New file
      if (initialContent) {
        if (typeof initialContent === 'string') {
          bytes.value = encoder.encode(initialContent);
          mime.value = 'text/plain';
        } else if (initialContent instanceof Uint8Array) {
          bytes.value = initialContent;
          mime.value = fileOptions.mime || 'application/octet-stream';
        }
        dirty.value = true;
      }
      return;
    }

    if (!meta.activeKey || meta.headVersion === 0) return;

    loading.value = true;
    try {
      const encrypted = await globalState.db.value.get('files', meta.activeKey);
      if (!encrypted) {
        delete globalState.metadata.files[filename];
        await saveMetadata();
        throw new Error(`File "${filename}" is corrupted and has been removed.`);
      }

      const decrypted = await cryptoUtils.decrypt(encrypted, globalState.keys.value.encKey);
      const inflated = await compress.inflate(decrypted);

      // Verify integrity
      const hash = cryptoUtils.hash(inflated);
      const chain = await globalState.chainManager.value.getChain(meta.chainId);
      const latest = chain.versions[chain.versions.length - 1];

      if (!latest || hash !== latest.hash || !globalState.keys.value.verify(hash, latest.sig)) {
        throw new Error(`File "${filename}" failed integrity verification.`);
      }

      bytes.value = inflated;
      mime.value = meta.mime || 'application/octet-stream';
      dirty.value = false;

    } catch (e) {
      console.error('Load error:', e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function save() {
    if (!dirty.value || !globalState.auth.value) return;

    const hash = cryptoUtils.hash(bytes.value);

    // Ensure metadata exists
    if (!globalState.metadata.files[filename]) {
      const chainId = cryptoUtils.generateChainId();
      globalState.metadata.files[filename] = {
        mime: mime.value,
        chainId,
        headVersion: 0,
        lastModified: Date.now(),
        lastSize: bytes.value.length,
        lastCompressedSize: 0,
        activeKey: null
      };
    }

    const meta = globalState.metadata.files[filename];

    // Check if content unchanged
    try {
      const chain = await globalState.chainManager.value.getChain(meta.chainId);
      const latest = chain.versions[chain.versions.length - 1];
      if (latest?.hash === hash) {
        if (meta.mime !== mime.value) {
          meta.mime = mime.value;
          await saveMetadata();
        }
        dirty.value = false;
        return;
      }
    } catch (error) {
      console.warn('Chain verification failed, continuing with save:', error);
    }

    const sig = globalState.keys.value.sign(hash);
    const key = cryptoUtils.generateKey();
    const version = meta.headVersion + 1;

    let compressed, encrypted;
    try {
      compressed = await compress.deflate(bytes.value);
      encrypted = await cryptoUtils.encrypt(compressed, globalState.keys.value.encKey);
    } catch (error) {
      console.error('Failed to compress/encrypt data:', error);
      throw new Error(`Failed to prepare file data: ${error.message}`);
    }

    // Atomic save
    const tx = globalState.db.value.transaction(['files', 'meta'], 'readwrite');
    try {
      await tx.objectStore('files').put(encrypted, key);

      // Update metadata
      meta.mime = mime.value;
      meta.headVersion = version;
      meta.lastModified = Date.now();
      meta.lastSize = bytes.value.length;
      meta.lastCompressedSize = compressed.length;
      meta.activeKey = key;

      const metaBytes = encoder.encode(JSON.stringify({
        files: globalState.metadata.files,
        schemaVersion: 5
      }));
      const metaEncrypted = await cryptoUtils.encrypt(metaBytes, globalState.keys.value.encKey);
      await tx.objectStore('meta').put(metaEncrypted, 'index');

      await tx.done;

      // Update chain after successful transaction
      try {
        await globalState.chainManager.value.addVersion(meta.chainId, {
          version, hash, sig, key,
          size: bytes.value.length,
          ts: Date.now()
        });
      } catch (chainError) {
        console.warn('Chain update failed (file saved successfully):', chainError);
        // Don't throw - file is saved, chain can be rebuilt
      }

      dirty.value = false;
    } catch (error) {
      console.error('Save transaction failed:', error);
      try { tx.abort(); } catch { }
      throw new Error(`Save failed: ${error.message}`);
    }
  }

  async function rename(newName) {
    if (!newName || globalState.metadata.files[newName]) return false;
    if (!globalState.metadata.files[filename]) return false;

    globalState.metadata.files[newName] = globalState.metadata.files[filename];
    delete globalState.metadata.files[filename];
    await saveMetadata();

    // Update internal filename reference
    Object.defineProperty(instance, 'filename', { value: newName, writable: false });
    return true;
  }

  async function deleteFile() {
    const meta = globalState.metadata.files[filename];
    if (!meta) return;

    const keysToDelete = [];
    if (meta.chainId) {
      try {
        const chain = await globalState.chainManager.value.getChain(meta.chainId);
        keysToDelete.push(...chain.versions.map(v => v.key).filter(Boolean));
      } catch (e) {
        console.warn('Failed to collect keys for deletion:', e);
      }
    }
    if (meta.activeKey) keysToDelete.push(meta.activeKey);

    const tx = globalState.db.value.transaction(['files', 'meta', 'chains'], 'readwrite');
    try {
      for (const key of keysToDelete) {
        await tx.objectStore('files').delete(key);
      }
      if (meta.chainId) {
        await tx.objectStore('chains').delete(meta.chainId);
      }

      delete globalState.metadata.files[filename];
      const metaBytes = encoder.encode(JSON.stringify({
        files: globalState.metadata.files,
        schemaVersion: 5
      }));
      const metaEncrypted = await cryptoUtils.encrypt(metaBytes, globalState.keys.value.encKey);
      await tx.objectStore('meta').put(metaEncrypted, 'index');

      await tx.done;

      // Reset instance state
      bytes.value = new Uint8Array();
      dirty.value = false;
    } catch (error) {
      try { tx.abort(); } catch { }
      throw error;
    }
  }

  async function importFile(file) {
    if (!globalState.auth.value) throw new Error('Not authenticated');

    mime.value = file.type || 'application/octet-stream';
    bytes.value = new Uint8Array(await file.arrayBuffer());
    dirty.value = true;

    // Auto-save imported files
    try {
      await save();
    } catch (error) {
      console.error('Auto-save after import failed:', error);
      throw new Error(`Import successful but save failed: ${error.message}`);
    }
  }

  function exportFile() {
    const blob = new Blob([bytes.value], { type: mime.value });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // URL.revokeObjectURL(url);
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

  // Cleanup timer on instance destruction
  const cleanup = () => clearTimeout(saveTimer);
  if (typeof onBeforeUnmount === 'function') {
    onBeforeUnmount(cleanup);
  }

  return instance;
}

// Helper to save metadata (used internally)
async function saveMetadata() {
  if (!globalState.auth.value) return;
  const data = { files: globalState.metadata.files, schemaVersion: 5 };
  const bytes = encoder.encode(JSON.stringify(data));
  const encrypted = await cryptoUtils.encrypt(bytes, globalState.keys.value.encKey);
  await globalState.db.value.put('meta', encrypted, 'index');
}