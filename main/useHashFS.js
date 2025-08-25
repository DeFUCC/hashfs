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
      size: meta.lastSize || 0,
      compressedSize: meta.lastCompressedSize || 0,
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
      // Get all referenced keys from all chains and metadata
      const referenced = new Set();
      const ghostFiles = [];

      for (const [fileName, meta] of Object.entries(metadata.files)) {
        let hasValidContent = false;

        if (meta.chainId) {
          try {
            const chain = await chainManager.value.getChain(meta.chainId);
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
          // Verify the active key actually exists
          try {
            const exists = await db.value.get('files', meta.activeKey);
            if (exists) {
              referenced.add(meta.activeKey);
              hasValidContent = true;
            } else {
              console.warn(`Ghost file detected: ${fileName} - activeKey ${meta.activeKey} not found`);
            }
          } catch (error) {
            console.warn(`Error checking activeKey for ${fileName}:`, error);
          }
        }

        // If file has no valid content, mark as ghost
        if (!hasValidContent && (meta.activeKey || meta.headVersion > 0)) {
          ghostFiles.push(fileName);
        }
      }

      // Remove ghost files from metadata
      if (ghostFiles.length > 0) {
        console.warn('Removing ghost files:', ghostFiles);
        ghostFiles.forEach(name => delete metadata.files[name]);
        await saveMetadata();
      }

      // Clean orphaned files from database
      const allKeys = await db.value.getAllKeys('files');
      const orphaned = allKeys.filter(key => !referenced.has(key));

      if (orphaned.length > 0) {
        const tx = db.value.transaction(['files'], 'readwrite');
        const store = tx.objectStore('files');

        for (const key of orphaned) {
          try {
            await store.delete(key);
          } catch (e) {
            console.warn('Cleanup failed for:', key, e);
          }
        }

        await tx.done;
        console.log(`Cleaned up ${orphaned.length} orphaned files and ${ghostFiles.length} ghost files`);
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

    const meta = metadata.files[name];
    if (!meta) {
      // New file
      const chainId = cryptoUtils.generateChainId();
      metadata.files[name] = {
        mime: 'text/markdown',
        chainId,
        headVersion: 0,
        lastModified: Date.now(),
        lastSize: 0,
        lastCompressedSize: 0,
        activeKey: null
      };

      const welcome = `# Welcome to ${name}\n\nStart editing your encrypted file...`;
      current.bytes = encoder.encode(welcome);
      current.dirty = true;
      return;
    }

    current.mime = meta.mime;

    // Check if file actually has content
    if (!meta.activeKey || meta.headVersion === 0) {
      console.warn(`File "${name}" has no content, treating as new file`);
      return;
    }

    loading.value = true;
    try {
      // Verify file exists in database first
      const encrypted = await db.value.get('files', meta.activeKey);
      if (!encrypted) {
        console.error(`File data not found for "${name}", key: ${meta.activeKey}`);

        // Handle ghost file - remove from metadata
        delete metadata.files[name];
        await saveMetadata();

        throw new Error(`File "${name}" is corrupted and has been removed from the file list. Please create a new file with this name if needed.`);
      }

      const decrypted = await cryptoUtils.decrypt(encrypted, keys.value.encKey);
      const inflated = await compress.inflate(decrypted);

      // Verify against chain
      const hash = cryptoUtils.hash(inflated);
      const chain = await chainManager.value.getChain(meta.chainId);
      const latest = chain.versions[chain.versions.length - 1];

      if (!latest || hash !== latest.hash || !keys.value.verify(hash, latest.sig)) {
        console.error(`Integrity verification failed for "${name}"`);
        throw new Error(`File "${name}" failed integrity verification. The file may be corrupted.`);
      }

      current.bytes = inflated;
      current.dirty = false;

    } catch (e) {
      console.error('Load error:', e);
      alert(e.message);

      // If it's a ghost file, clean up
      if (e.message.includes('File data not found') || e.message.includes('corrupted')) {
        Object.assign(current, {
          name: '',
          mime: 'text/markdown',
          bytes: new Uint8Array(),
          dirty: false
        });
      }
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
        lastSize: bytes.length,
        lastCompressedSize: 0,
        activeKey: null
      };
    }

    const meta = metadata.files[name];

    // Check if content is unchanged
    try {
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
    } catch (error) {
      console.warn('Chain verification failed, continuing with save:', error);
    }

    // Prepare new version data
    const sig = keys.value.sign(hash);
    const key = cryptoUtils.generateKey();
    const version = meta.headVersion + 1;

    let compressed, encrypted, metaEncrypted;

    try {
      compressed = await compress.deflate(bytes);
      encrypted = await cryptoUtils.encrypt(compressed, keys.value.encKey);

      // Prepare updated metadata
      const updatedMetadata = {
        ...metadata.files,
        [name]: {
          ...meta,
          mime,
          headVersion: version,
          lastModified: Date.now(),
          lastSize: bytes.length,
          lastCompressedSize: compressed.length,
          activeKey: key
        }
      };

      const metaBytes = encoder.encode(JSON.stringify({
        files: updatedMetadata,
        schemaVersion: 4
      }));
      metaEncrypted = await cryptoUtils.encrypt(metaBytes, keys.value.encKey);
    } catch (error) {
      console.error('Failed to prepare save data:', error);
      throw error;
    }

    // Atomic transaction
    const tx = db.value.transaction(['files', 'meta'], 'readwrite');
    const filesStore = tx.objectStore('files');
    const metaStore = tx.objectStore('meta');

    try {
      await filesStore.put(encrypted, key);
      await metaStore.put(metaEncrypted, 'index');
      await tx.done;

      // Update in-memory metadata only after successful transaction
      meta.mime = mime;
      meta.headVersion = version;
      meta.lastModified = Date.now();
      meta.lastSize = bytes.length;
      meta.lastCompressedSize = compressed.length;
      meta.activeKey = key;

      // Update chain after successful storage
      try {
        await chainManager.value.addVersion(meta.chainId, {
          version,
          hash,
          sig,
          key,
          size: bytes.length,
          ts: Date.now()
        });
      } catch (chainError) {
        console.error('Chain update failed:', chainError);
        // Don't throw - file is saved, chain can be rebuilt
      }

      current.dirty = false;

    } catch (error) {
      console.error('Save failed:', error);
      try {
        tx.abort();
      } catch (abortError) {
        console.warn('Failed to abort transaction:', abortError);
      }
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
    if (!meta) return; // Already deleted

    // Collect all keys to delete BEFORE starting transaction
    const keysToDelete = [];
    let chainId = null;

    try {
      if (meta.chainId) {
        chainId = meta.chainId;
        const chain = await chainManager.value.getChain(meta.chainId);
        keysToDelete.push(...chain.versions.map(v => v.key).filter(Boolean));
      }
      if (meta.activeKey) {
        keysToDelete.push(meta.activeKey);
      }
    } catch (error) {
      console.warn('Failed to collect keys for deletion:', error);
      // Continue with deletion anyway to clean up metadata
    }

    // Prepare new metadata WITHOUT the deleted file
    const newMetadata = { ...metadata.files };
    delete newMetadata[name];

    const metaBytes = encoder.encode(JSON.stringify({
      files: newMetadata,
      schemaVersion: 4
    }));

    let metaEncrypted;
    try {
      metaEncrypted = await cryptoUtils.encrypt(metaBytes, keys.value.encKey);
    } catch (error) {
      console.error('Failed to encrypt metadata:', error);
      return;
    }

    // Start atomic transaction
    const tx = db.value.transaction(['files', 'meta', 'chains'], 'readwrite');
    const filesStore = tx.objectStore('files');
    const metaStore = tx.objectStore('meta');
    const chainsStore = tx.objectStore('chains');

    try {
      // Delete all file content keys
      for (const key of keysToDelete) {
        try {
          await filesStore.delete(key);
        } catch (e) {
          console.warn('Failed to delete file content:', key, e);
          // Continue with other deletions
        }
      }

      // Delete chain if it exists
      if (chainId) {
        try {
          await chainsStore.delete(chainId);
        } catch (e) {
          console.warn('Failed to delete chain:', chainId, e);
        }
      }

      // Update metadata last
      await metaStore.put(metaEncrypted, 'index');

      // Wait for transaction to complete
      await tx.done;

      // Only update in-memory metadata AFTER successful transaction
      delete metadata.files[name];

      // Clear current file if it was the deleted one
      if (current.name === name) {
        Object.assign(current, {
          name: '',
          mime: 'text/markdown',
          bytes: new Uint8Array(),
          dirty: false
        });
      }

      console.log(`Successfully deleted file: ${name}`);

    } catch (error) {
      console.error('Delete transaction failed:', error);
      try {
        tx.abort();
      } catch (abortError) {
        console.warn('Failed to abort transaction:', abortError);
      }

      // Don't update metadata on failure - keep it consistent
      alert(`Failed to delete file "${name}": ${error.message}`);
      throw error;
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