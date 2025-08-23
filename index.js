import { ref, computed, onBeforeUnmount } from 'vue';
import { openDB } from 'idb';
import { deflate, inflate } from 'fflate';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { randomBytes } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Crypto utilities - centralized and optimized
export const cryptoUtils = {
  // Check if Web Crypto API is available
  get isSecureContext() {
    return typeof window !== 'undefined' &&
      window.isSecureContext &&
      typeof window.crypto?.subtle !== 'undefined';
  },

  async deriveKeys(pwd) {
    if (!this.isSecureContext) {
      throw new Error('Secure context required. Please use HTTPS or localhost.');
    }

    const pwdBytes = encoder.encode(String(pwd || '').normalize('NFC').trim());
    if (pwdBytes.length < 8) throw new Error('Password too short');

    // Use @noble/hashes for consistent, auditable PBKDF2
    const salt = encoder.encode('hashfs-v3-2025');
    const masterKey = pbkdf2(sha256, pwdBytes, salt, { c: 120000, dkLen: 64 });

    // Derive keys from master key
    const sigKey = masterKey.slice(0, 32);
    const encKeyBytes = masterKey.slice(32, 64);
    const pubKey = ed25519.getPublicKey(sigKey);

    // WebCrypto AES key for performance
    const encKey = await window.crypto.subtle.importKey(
      'raw', encKeyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']
    );

    // Database name from public key hash
    const dbName = bytesToHex(sha256(pubKey).slice(0, 16));

    return {
      sigKey,
      pubKey,
      encKey,
      dbName,
      sign: (hash) => bytesToHex(ed25519.sign(hexToBytes(hash), sigKey)),
      verify: (hash, sig) => {
        try { return ed25519.verify(hexToBytes(sig), hexToBytes(hash), pubKey); }
        catch { return false; }
      }
    };
  },

  hash: (bytes) => bytesToHex(sha256(bytes)),

  async encrypt(bytes, key) {
    if (!this.isSecureContext) {
      throw new Error('Encryption requires secure context');
    }

    const iv = randomBytes(12);
    const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { iv, data: new Uint8Array(encrypted) };
  },

  async decrypt(payload, key) {
    if (!this.isSecureContext) {
      throw new Error('Decryption requires secure context');
    }

    return new Uint8Array(await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.iv }, key, payload.data
    ));
  }
};

// Compression utilities
const compress = {
  deflate: (bytes) => new Promise((resolve, reject) =>
    deflate(bytes, (err, result) => err ? reject(err) : resolve(result))),
  inflate: (bytes) => new Promise((resolve, reject) =>
    inflate(bytes, (err, result) => err ? reject(err) : resolve(result)))
};

export function useHashFS(passphrase) {
  const auth = ref(false);
  const keys = ref(null);
  const db = ref(null);
  const loading = ref(false);

  const files = ref({});
  const current = ref({ name: '', mime: 'text/markdown', bytes: new Uint8Array(), dirty: false });

  let saveTimer = null;
  const scheduleAutoSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveFile, 800);
  };

  const filesList = computed(() =>
    Object.entries(files.value).map(([name, meta]) => {
      const latest = meta.versions[meta.versions.length - 1] || {};
      return {
        name,
        mime: meta.mime || 'text/markdown',
        versions: meta.versions.length,
        size: latest.size || 0,
        modified: latest.ts || 0,
        active: current.value.name === name
      };
    }).sort((a, b) => a.name.localeCompare(b.name))
  );

  const contentText = computed({
    get: () => {
      try { return decoder.decode(current.value.bytes); }
      catch { return ''; }
    },
    set: (text) => {
      current.value.bytes = encoder.encode(text || '');
      current.value.dirty = true;
      scheduleAutoSave();
    }
  });

  async function login() {
    if (!String(passphrase || '').trim()) return;

    // Check for secure context first
    if (!cryptoUtils.isSecureContext) {
      throw new Error('Secure context required. Please use HTTPS or localhost.');
    }

    loading.value = true;

    try {
      keys.value = await cryptoUtils.deriveKeys(passphrase);

      db.value = await openDB(keys.value.dbName, 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        }
      });

      // Load and decrypt metadata
      try {
        const encrypted = await db.value.get('meta', 'index');
        if (encrypted) {
          const decrypted = await cryptoUtils.decrypt(encrypted, keys.value.encKey);
          files.value = JSON.parse(decoder.decode(decrypted)) || {};
        }
      } catch (e) {
        console.warn('Metadata load failed:', e);
        files.value = {};
      }

      // Cleanup orphaned data
      await cleanup();
      auth.value = true;

    } catch (e) {
      throw new Error('Authentication failed: ' + e.message);
    } finally {
      loading.value = false;
    }
  }

  async function saveMetadata() {
    const bytes = encoder.encode(JSON.stringify(files.value));
    const encrypted = await cryptoUtils.encrypt(bytes, keys.value.encKey);
    await db.value.put('meta', encrypted, 'index');
  }

  async function cleanup() {
    try {
      // Get all referenced keys
      const referenced = new Set();
      Object.values(files.value).forEach(meta =>
        meta.versions?.forEach(v => v.key && referenced.add(v.key))
      );

      // Get all existing keys
      const allKeys = await db.value.getAllKeys('files');
      const orphanKeys = allKeys.filter(key => !referenced.has(key));

      if (orphanKeys.length > 0) {
        const tx = db.value.transaction(['files'], 'readwrite');
        const filesStore = tx.objectStore('files');

        for (const key of orphanKeys) {
          try {
            await filesStore.delete(key);
          } catch (e) {
            console.warn('Failed to delete orphan key:', key, e);
          }
        }

        await tx.done;
        console.log(`Cleaned up ${orphanKeys.length} orphaned files`);
      }

      // Clean metadata of missing versions
      let changed = false;
      const presentKeys = new Set(allKeys);

      for (const meta of Object.values(files.value)) {
        const before = meta.versions?.length || 0;
        meta.versions = (meta.versions || []).filter(v => presentKeys.has(v.key));
        if (meta.versions.length !== before) changed = true;
      }

      if (changed) {
        await saveMetadata();
        console.log('Updated metadata after cleanup');
      }

    } catch (error) {
      console.warn('Cleanup failed:', error);
    }
  }

  async function selectFile(name) {
    if (current.value.dirty) await saveFile();

    current.value = { name, mime: 'text/markdown', bytes: new Uint8Array(), dirty: false };

    if (!files.value[name]) {
      files.value[name] = { mime: 'text/markdown', versions: [] };
      const welcome = `# Welcome to ${name}\n\nStart editing your encrypted file...`;
      current.value.bytes = encoder.encode(welcome);
      current.value.dirty = true;
      return;
    }

    const meta = files.value[name];
    const latest = meta.versions[meta.versions.length - 1];
    current.value.mime = meta.mime;

    if (!latest) return;

    loading.value = true;
    try {
      const encrypted = await db.value.get('files', latest.key);
      if (!encrypted) throw new Error('File data not found');

      const decrypted = await cryptoUtils.decrypt(encrypted, keys.value.encKey);
      const inflated = await compress.inflate(decrypted);

      // Verify integrity
      const hash = cryptoUtils.hash(inflated);
      if (hash !== latest.hash || !keys.value.verify(hash, latest.sig)) {
        throw new Error('File integrity verification failed');
      }

      current.value.bytes = inflated;
      current.value.dirty = false;

    } catch (e) {
      console.error('Load error:', e);
      alert(e.message);
    } finally {
      loading.value = false;
    }
  }

  async function saveFile() {
    if (!current.value.name || !current.value.dirty) return;

    const { name, mime, bytes } = current.value;
    const hash = cryptoUtils.hash(bytes);

    // Ensure file metadata exists
    if (!files.value[name]) {
      files.value[name] = { mime, versions: [] };
    }

    const meta = files.value[name];
    const latest = meta.versions[meta.versions.length - 1];

    // Skip if content unchanged
    if (latest?.hash === hash) {
      if (meta.mime !== mime) {
        meta.mime = mime;
        await saveMetadata();
      }
      current.value.dirty = false;
      return;
    }

    // Create new version
    const sig = keys.value.sign(hash);
    const key = `${hash}:${sig}`;

    const compressed = await compress.deflate(bytes);
    const encrypted = await cryptoUtils.encrypt(compressed, keys.value.encKey);

    // Update metadata
    meta.mime = mime;
    meta.versions.push({
      hash, sig, key,
      size: bytes.length,
      ts: Date.now()
    });

    // Keep only last 10 versions
    const toDelete = [];
    while (meta.versions.length > 10) {
      toDelete.push(meta.versions.shift().key);
    }

    // Prepare metadata encryption before transaction
    const metaBytes = encoder.encode(JSON.stringify(files.value));
    const metaEncrypted = await cryptoUtils.encrypt(metaBytes, keys.value.encKey);

    // Atomic save transaction
    const tx = db.value.transaction(['files', 'meta'], 'readwrite');
    const filesStore = tx.objectStore('files');
    const metaStore = tx.objectStore('meta');

    try {
      // Store new file version
      await filesStore.put(encrypted, key);

      // Delete old versions
      for (const k of toDelete) {
        try {
          await filesStore.delete(k);
        } catch (e) {
          console.warn('Failed to delete old version:', k, e);
        }
      }

      // Update metadata
      await metaStore.put(metaEncrypted, 'index');

      // Wait for transaction to complete
      await tx.done;
      current.value.dirty = false;

    } catch (error) {
      console.error('Transaction failed:', error);
      tx.abort();
      throw error;
    }
  }

  function newFile(name) {
    name = name?.trim() || prompt('File name:')?.trim();
    if (!name) return false;
    if (files.value[name]) {
      alert('File already exists');
      return false;
    }
    selectFile(name);
    return true;
  }

  async function deleteFile(name) {
    if (!confirm(`Delete "${name}"?`)) return;

    const meta = files.value[name];
    const keysToDelete = meta?.versions?.map(v => v.key) || [];
    delete files.value[name];

    // Prepare metadata encryption
    const metaBytes = encoder.encode(JSON.stringify(files.value));
    const metaEncrypted = await cryptoUtils.encrypt(metaBytes, keys.value.encKey);

    const tx = db.value.transaction(['files', 'meta'], 'readwrite');
    const filesStore = tx.objectStore('files');
    const metaStore = tx.objectStore('meta');

    try {
      // Delete file versions
      for (const key of keysToDelete) {
        try {
          await filesStore.delete(key);
        } catch (e) {
          console.warn('Failed to delete file version:', key, e);
        }
      }

      // Update metadata
      await metaStore.put(metaEncrypted, 'index');

      await tx.done;

      if (current.value.name === name) {
        current.value = { name: '', mime: 'text/markdown', bytes: new Uint8Array(), dirty: false };
      }

    } catch (error) {
      console.error('Delete transaction failed:', error);
      tx.abort();
      throw error;
    }
  }

  async function importFile(file) {
    if (!file) return false;
    current.value = {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      bytes: new Uint8Array(await file.arrayBuffer()),
      dirty: true
    };
    return true;
  }

  function exportFile() {
    if (!current.value.name) return;
    const blob = new Blob([current.value.bytes], { type: current.value.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = current.value.name;
    a.click();
    // URL.revokeObjectURL(url);
  }

  async function renameFile(oldName, newName) {
    if (!files.value[oldName] || files.value[newName]) return false;
    files.value[newName] = files.value[oldName];
    delete files.value[oldName];
    await saveMetadata();
    if (current.value.name === oldName) current.value.name = newName;
    return true;
  }

  async function exportAll() {
    const exported = {};
    for (const [name, meta] of Object.entries(files.value)) {
      const latest = meta.versions[meta.versions.length - 1];
      if (latest) {
        try {
          const encrypted = await db.value.get('files', latest.key);
          const decrypted = await cryptoUtils.decrypt(encrypted, keys.value.encKey);
          const content = await compress.inflate(decrypted);
          exported[name] = {
            mime: meta.mime,
            content: Array.from(content) // Serializable
          };
        } catch (e) {
          console.warn(`Export failed for ${name}:`, e);
        }
      }
    }
    return exported;
  }

  // Cleanup on unmount
  onBeforeUnmount(() => clearTimeout(saveTimer));

  return {
    // State
    auth, loading, files: filesList,
    currentFile: computed(() => current.value.name),
    currentMime: computed({
      get: () => current.value.mime,
      set: (mime) => { current.value.mime = mime; current.value.dirty = true; }
    }),
    contentText,
    // Expose raw bytes for binary previews
    contentBytes: computed(() => current.value.bytes),
    isDirty: computed(() => current.value.dirty),

    // Core operations
    login, saveFile,

    // File operations
    selectFile, newFile, deleteFile, renameFile,
    importFile, exportFile, exportAll
  };
}