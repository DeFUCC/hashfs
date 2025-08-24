import { ref, computed, onBeforeUnmount, reactive } from 'vue';
import { openDB } from 'idb';
import { cryptoUtils, compress, createChainManager } from './crypto.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function useHashFS(passphrase) {
  const auth = ref(false);
  const keys = ref(null);
  const db = ref(null);
  const loading = ref(false);
  const chainManager = ref(null);

  const metadata = reactive({ files: {} });
  const current = reactive({
    name: '',
    mime: 'text/markdown',
    bytes: new Uint8Array(),
    dirty: false
  });

  let saveTimer = null;
  const scheduleAutoSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveFile, 800);
  };

  const filesList = computed(() =>
    Object.entries(metadata.files).map(([name, meta]) => ({
      name,
      mime: meta.mime || 'text/markdown',
      versions: meta.headVersion || 0,
      size: 0, // Lazily loaded when needed
      modified: meta.lastModified || 0,
      active: current.name === name
    })).sort((a, b) => a.name.localeCompare(b.name))
  );

  const contentText = computed({
    get: () => {
      try { return decoder.decode(current.bytes); }
      catch { return ''; }
    },
    set: (text) => {
      current.bytes = encoder.encode(text || '');
      current.dirty = true;
      scheduleAutoSave();
    }
  });

  async function login() {
    if (!String(passphrase || '').trim()) return;
    if (!cryptoUtils.isSecureContext) {
      throw new Error('Secure context required. Please use HTTPS or localhost.');
    }

    loading.value = true;
    try {
      keys.value = await cryptoUtils.deriveKeys(passphrase);

      db.value = await openDB(keys.value.dbName, 1, {
        upgrade(database) {
          if (!database.objectStoreNames.contains('files')) database.createObjectStore('files');
          if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta');
          if (!database.objectStoreNames.contains('chains')) database.createObjectStore('chains');
        }
      });

      chainManager.value = createChainManager(db.value, keys.value.encKey);

      // Load metadata
      try {
        const encrypted = await db.value.get('meta', 'index');
        if (encrypted) {
          const decrypted = await cryptoUtils.decrypt(encrypted, keys.value.encKey);
          const data = JSON.parse(decoder.decode(decrypted));
          Object.assign(metadata.files, data.files || {});
        }
      } catch (e) {
        console.warn('Metadata load failed:', e);
      }

      await cleanup();
      auth.value = true;

    } catch (e) {
      throw new Error('Authentication failed: ' + e.message);
    } finally {
      loading.value = false;
    }
  }

  async function saveMetadata() {
    const data = { files: metadata.files, schemaVersion: 4 };
    const bytes = encoder.encode(JSON.stringify(data));
    const encrypted = await cryptoUtils.encrypt(bytes, keys.value.encKey);
    await db.value.put('meta', encrypted, 'index');
  }

  async function cleanup() {
    try {
      // Get all referenced keys from all chains
      const referenced = new Set();

      for (const meta of Object.values(metadata.files)) {
        if (meta.chainId) {
          const chain = await chainManager.value.getChain(meta.chainId);
          chain.versions.forEach(v => v.key && referenced.add(v.key));
        }
        if (meta.activeKey) referenced.add(meta.activeKey);
      }

      // Clean orphaned files
      const allKeys = await db.value.getAllKeys('files');
      const orphaned = allKeys.filter(key => !referenced.has(key));

      if (orphaned.length > 0) {
        const tx = db.value.transaction(['files'], 'readwrite');
        const store = tx.objectStore('files');

        for (const key of orphaned) {
          try { await store.delete(key); }
          catch (e) { console.warn('Cleanup failed for:', key); }
        }
        await tx.done;
        console.log(`Cleaned up ${orphaned.length} orphaned files`);
      }

    } catch (error) {
      console.warn('Cleanup failed:', error);
    }
  }

  async function selectFile(name) {
    if (current.dirty) await saveFile();

    Object.assign(current, {
      name,
      mime: 'text/markdown',
      bytes: new Uint8Array(),
      dirty: false
    });

    if (!metadata.files[name]) {
      // New file
      const chainId = cryptoUtils.generateChainId();
      metadata.files[name] = {
        mime: 'text/markdown',
        chainId,
        headVersion: 0,
        lastModified: Date.now(),
        activeKey: null
      };

      const welcome = `# Welcome to ${name}\n\nStart editing your encrypted file...`;
      current.bytes = encoder.encode(welcome);
      current.dirty = true;
      return;
    }

    const meta = metadata.files[name];
    current.mime = meta.mime;

    if (!meta.activeKey || meta.headVersion === 0) return;

    loading.value = true;
    try {
      const encrypted = await db.value.get('files', meta.activeKey);
      if (!encrypted) throw new Error('File data not found');

      const decrypted = await cryptoUtils.decrypt(encrypted, keys.value.encKey);
      const inflated = await compress.inflate(decrypted);

      // Verify against chain
      const hash = cryptoUtils.hash(inflated);
      const chain = await chainManager.value.getChain(meta.chainId);
      const latest = chain.versions[chain.versions.length - 1];

      if (!latest || hash !== latest.hash || !keys.value.verify(hash, latest.sig)) {
        throw new Error('File integrity verification failed');
      }

      current.bytes = inflated;
      current.dirty = false;

    } catch (e) {
      console.error('Load error:', e);
      alert(e.message);
    } finally {
      loading.value = false;
    }
  }

  async function saveFile() {
    if (!current.name || !current.dirty) return;

    const { name, mime, bytes } = current;
    const hash = cryptoUtils.hash(bytes);

    // Ensure file metadata exists
    if (!metadata.files[name]) {
      const chainId = cryptoUtils.generateChainId();
      metadata.files[name] = {
        mime,
        chainId,
        headVersion: 0,
        lastModified: Date.now(),
        activeKey: null
      };
    }

    const meta = metadata.files[name];

    // Check if content is unchanged
    const chain = await chainManager.value.getChain(meta.chainId);
    const latest = chain.versions[chain.versions.length - 1];

    if (latest?.hash === hash) {
      if (meta.mime !== mime) {
        meta.mime = mime;
        await saveMetadata();
      }
      current.dirty = false;
      return;
    }

    // Create new version
    const sig = keys.value.sign(hash);
    const key = cryptoUtils.generateKey();
    const version = meta.headVersion + 1;

    const compressed = await compress.deflate(bytes);
    const encrypted = await cryptoUtils.encrypt(compressed, keys.value.encKey);

    // Prepare metadata update
    meta.mime = mime;
    meta.headVersion = version;
    meta.lastModified = Date.now();
    meta.activeKey = key;

    const metaBytes = encoder.encode(JSON.stringify({
      files: metadata.files,
      schemaVersion: 4
    }));
    const metaEncrypted = await cryptoUtils.encrypt(metaBytes, keys.value.encKey);

    // Atomic transaction
    const tx = db.value.transaction(['files', 'meta'], 'readwrite');
    const filesStore = tx.objectStore('files');
    const metaStore = tx.objectStore('meta');

    try {
      await filesStore.put(encrypted, key);
      await metaStore.put(metaEncrypted, 'index');
      await tx.done;

      // Update chain after successful storage
      await chainManager.value.addVersion(meta.chainId, {
        version,
        hash,
        sig,
        key,
        size: bytes.length,
        ts: Date.now()
      });

      current.dirty = false;

    } catch (error) {
      console.error('Save failed:', error);
      tx.abort();
      throw error;
    }
  }

  function newFile(name) {
    name = name?.trim() || prompt('File name:')?.trim();
    if (!name || metadata.files[name]) {
      if (metadata.files[name]) alert('File already exists');
      return false;
    }
    selectFile(name);
    return true;
  }

  async function deleteFile(name) {
    if (!confirm(`Delete "${name}"?`)) return;

    const meta = metadata.files[name];
    delete metadata.files[name];

    // Clean up chain and files
    if (meta?.chainId) {
      const chain = await chainManager.value.getChain(meta.chainId);
      const keysToDelete = chain.versions.map(v => v.key);

      if (meta.activeKey) keysToDelete.push(meta.activeKey);

      const tx = db.value.transaction(['files', 'meta', 'chains'], 'readwrite');

      try {
        // Delete files
        const filesStore = tx.objectStore('files');
        for (const key of keysToDelete) {
          try { await filesStore.delete(key); }
          catch (e) { console.warn('Delete failed for:', key); }
        }

        // Delete chain
        await tx.objectStore('chains').delete(meta.chainId);

        // Update metadata
        const metaBytes = encoder.encode(JSON.stringify({
          files: metadata.files,
          schemaVersion: 4
        }));
        const metaEncrypted = await cryptoUtils.encrypt(metaBytes, keys.value.encKey);
        await tx.objectStore('meta').put(metaEncrypted, 'index');

        await tx.done;
      } catch (error) {
        console.error('Delete transaction failed:', error);
        tx.abort();
        throw error;
      }
    }

    if (current.name === name) {
      Object.assign(current, {
        name: '',
        mime: 'text/markdown',
        bytes: new Uint8Array(),
        dirty: false
      });
    }
  }

  async function importFile(file) {
    if (!file) return false;
    Object.assign(current, {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      bytes: new Uint8Array(await file.arrayBuffer()),
      dirty: true
    });
    return true;
  }

  function exportFile() {
    if (!current.name) return;
    const blob = new Blob([current.bytes], { type: current.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = current.name;
    a.click();
  }

  async function renameFile(oldName, newName) {
    if (!metadata.files[oldName] || metadata.files[newName]) return false;
    metadata.files[newName] = metadata.files[oldName];
    delete metadata.files[oldName];
    await saveMetadata();
    if (current.name === oldName) current.name = newName;
    return true;
  }

  async function exportAll() {
    const exported = {};
    for (const [name, meta] of Object.entries(metadata.files)) {
      if (meta.activeKey) {
        try {
          const encrypted = await db.value.get('files', meta.activeKey);
          const decrypted = await cryptoUtils.decrypt(encrypted, keys.value.encKey);
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

  onBeforeUnmount(() => clearTimeout(saveTimer));

  return {
    // State
    auth, loading, files: filesList,
    currentFile: computed(() => current.name),
    currentMime: computed({
      get: () => current.mime,
      set: (mime) => { current.mime = mime; current.dirty = true; }
    }),
    contentText,
    contentBytes: computed(() => current.bytes),
    isDirty: computed(() => current.dirty),

    // Operations
    login, saveFile, selectFile, newFile, deleteFile, renameFile,
    importFile, exportFile, exportAll
  };
}