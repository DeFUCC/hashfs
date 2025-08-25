// storage-worker.js - Web Worker for encrypted file operations
import { deflate, inflate } from 'fflate';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { openDB } from 'idb';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let state = {
  auth: false,
  keys: null,
  db: null,
  metadata: { files: {} },
  chainManager: null,
  bufferRegistry: new Map() // Track SharedArrayBuffers
};

// Pure @noble crypto utilities (worker-compatible)
const crypto = {
  deriveKeys(pwd) {
    const pwdBytes = encoder.encode(String(pwd).normalize('NFC').trim());
    if (pwdBytes.length < 8) throw new Error('Password too short');

    const salt = encoder.encode('hashfs-v4-2025');
    const masterKey = pbkdf2(sha256, pwdBytes, salt, { c: 120000, dkLen: 64 });

    const sigKey = masterKey.slice(0, 32);
    const encKey = masterKey.slice(32, 64);
    const pubKey = ed25519.getPublicKey(sigKey);

    return {
      sigKey,
      pubKey,
      encKey,
      dbName: bytesToHex(sha256(pubKey).slice(0, 16)) + '-hashfs-v4',
      sign: (hash) => bytesToHex(ed25519.sign(hexToBytes(hash), sigKey)),
      verify: (hash, sig) => {
        try { return ed25519.verify(hexToBytes(sig), hexToBytes(hash), pubKey); }
        catch { return false; }
      }
    };
  },

  hash: (bytes) => bytesToHex(sha256(bytes)),
  generateKey: () => 'sk_' + bytesToHex(randomBytes(12)),
  generateChainId: () => bytesToHex(randomBytes(16)).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),

  encrypt(bytes, key) {
    const iv = randomBytes(12);
    const cipher = gcm(key, iv);
    const encrypted = cipher.encrypt(bytes);
    return { iv, data: encrypted };
  },

  decrypt(payload, key) {
    const cipher = gcm(key, payload.iv);
    return cipher.decrypt(payload.data);
  }
};

function createChainManager(db, encKey) {
  const cache = new Map();

  async function getChain(chainId) {
    if (cache.has(chainId)) return cache.get(chainId);

    try {
      const encrypted = await db.get('chains', chainId);
      if (!encrypted) return { versions: [] };

      const decrypted = crypto.decrypt(encrypted, encKey);
      const chain = JSON.parse(decoder.decode(decrypted));

      if (cache.size >= 10) cache.delete(cache.keys().next().value);
      cache.set(chainId, chain);
      return chain;
    } catch {
      return { versions: [] };
    }
  }

  async function saveChain(chainId, chain) {
    const bytes = encoder.encode(JSON.stringify(chain));
    const encrypted = crypto.encrypt(bytes, encKey);
    await db.put('chains', encrypted, chainId);
    cache.set(chainId, chain);
  }

  async function addVersion(chainId, version) {
    const chain = await getChain(chainId);
    chain.versions.push(version);

    // Keep last 15 versions
    const toDelete = [];
    while (chain.versions.length > 15) {
      const old = chain.versions.shift();
      toDelete.push(old.key);
    }

    await saveChain(chainId, chain);

    // Cleanup orphaned content
    if (toDelete.length > 0) {
      const tx = db.transaction(['files'], 'readwrite');
      for (const key of toDelete) {
        try { await tx.objectStore('files').delete(key); } catch { }
      }
      await tx.done;
    }

    return chain;
  }

  return { getChain, saveChain, addVersion };
}

// SharedArrayBuffer utilities
function createSharedBuffer(size) {
  const sab = new SharedArrayBuffer(size + 8); // +8 for length prefix
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab, 8);
  return { sab, view, bytes, setLength: (len) => view.setUint32(0, len) };
}

function writeToBuffer(buffer, data) {
  const { view, bytes } = buffer;
  const len = Math.min(data.length, bytes.length);
  bytes.set(data.subarray(0, len));
  view.setUint32(0, len);
  return len;
}

// Message handlers
const handlers = {
  login({ passphrase }) {
    try {
      state.keys = crypto.deriveKeys(passphrase);

      return openDB(state.keys.dbName, 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
          if (!db.objectStoreNames.contains('chains')) db.createObjectStore('chains');
        }
      }).then(async (database) => {
        state.db = database;
        state.chainManager = createChainManager(state.db, state.keys.encKey);

        // Load metadata
        try {
          const encrypted = await state.db.get('meta', 'index');
          if (encrypted) {
            const decrypted = crypto.decrypt(encrypted, state.keys.encKey);
            const data = JSON.parse(decoder.decode(decrypted));
            state.metadata.files = data.files || {};
          }
        } catch { }

        state.auth = true;
        return { success: true, files: Object.keys(state.metadata.files) };
      });
    } catch (error) {
      return Promise.resolve({ success: false, error: error.message });
    }
  },

  async loadFile({ name, bufferId }) {
    const meta = state.metadata.files[name];
    if (!meta?.activeKey) return { success: false, error: 'File not found' };

    try {
      const encrypted = await state.db.get('files', meta.activeKey);
      const decrypted = crypto.decrypt(encrypted, state.keys.encKey);
      const content = await new Promise((resolve, reject) =>
        inflate(decrypted, (err, result) => err ? reject(err) : resolve(result))
      );

      // Use shared buffer if provided
      if (bufferId && state.bufferRegistry.has(bufferId)) {
        const buffer = state.bufferRegistry.get(bufferId);
        writeToBuffer(buffer, content);
        return { success: true, mime: meta.mime, size: content.length, shared: true };
      }

      return {
        success: true,
        content: Array.from(content),
        mime: meta.mime,
        size: content.length
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async saveFile({ name, content, mime, bufferId }) {
    try {
      let bytes;

      if (bufferId && state.bufferRegistry.has(bufferId)) {
        const buffer = state.bufferRegistry.get(bufferId);
        const len = buffer.view.getUint32(0);
        bytes = buffer.bytes.slice(0, len);
      } else {
        bytes = new Uint8Array(content);
      }

      const hash = crypto.hash(bytes);

      // Ensure metadata exists
      if (!state.metadata.files[name]) {
        state.metadata.files[name] = {
          mime: mime || 'text/plain',
          chainId: crypto.generateChainId(),
          headVersion: 0,
          activeKey: null
        };
      }

      const meta = state.metadata.files[name];

      // Check if unchanged
      try {
        const chain = await state.chainManager.getChain(meta.chainId);
        const latest = chain.versions[chain.versions.length - 1];
        if (latest?.hash === hash) {
          return { success: true, unchanged: true };
        }
      } catch { }

      // Save new version
      const sig = state.keys.sign(hash);
      const key = crypto.generateKey();
      const version = meta.headVersion + 1;

      const compressed = await new Promise((resolve, reject) =>
        deflate(bytes, (err, result) => err ? reject(err) : resolve(result))
      );

      const encrypted = crypto.encrypt(compressed, state.keys.encKey);

      // Atomic transaction
      const tx = state.db.transaction(['files', 'meta'], 'readwrite');
      await tx.objectStore('files').put(encrypted, key);

      // Update metadata
      meta.mime = mime || meta.mime;
      meta.headVersion = version;
      meta.activeKey = key;
      meta.lastModified = Date.now();
      meta.lastSize = bytes.length;

      const metaBytes = encoder.encode(JSON.stringify({ files: state.metadata.files, schemaVersion: 4 }));
      const metaEncrypted = crypto.encrypt(metaBytes, state.keys.encKey);
      await tx.objectStore('meta').put(metaEncrypted, 'index');
      await tx.done;

      // Update chain
      await state.chainManager.addVersion(meta.chainId, {
        version, hash, sig, key, size: bytes.length, ts: Date.now()
      });

      return { success: true, version, size: bytes.length };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async deleteFile({ name }) {
    const meta = state.metadata.files[name];
    if (!meta) return { success: true };

    try {
      const keysToDelete = [];
      if (meta.chainId) {
        const chain = await state.chainManager.getChain(meta.chainId);
        keysToDelete.push(...chain.versions.map(v => v.key).filter(Boolean));
      }
      if (meta.activeKey) keysToDelete.push(meta.activeKey);

      const tx = state.db.transaction(['files', 'meta', 'chains'], 'readwrite');

      // Delete content
      for (const key of keysToDelete) {
        try { await tx.objectStore('files').delete(key); } catch { }
      }

      // Delete chain
      if (meta.chainId) {
        try { await tx.objectStore('chains').delete(meta.chainId); } catch { }
      }

      // Update metadata
      delete state.metadata.files[name];
      const metaBytes = encoder.encode(JSON.stringify({ files: state.metadata.files, schemaVersion: 4 }));
      const metaEncrypted = crypto.encrypt(metaBytes, state.keys.encKey);
      await tx.objectStore('meta').put(metaEncrypted, 'index');
      await tx.done;

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async renameFile({ oldName, newName }) {
    if (!state.metadata.files[oldName] || state.metadata.files[newName]) {
      return { success: false, error: 'Invalid rename operation' };
    }

    try {
      state.metadata.files[newName] = state.metadata.files[oldName];
      delete state.metadata.files[oldName];

      const metaBytes = encoder.encode(JSON.stringify({ files: state.metadata.files, schemaVersion: 4 }));
      const metaEncrypted = crypto.encrypt(metaBytes, state.keys.encKey);
      await state.db.put('meta', metaEncrypted, 'index');

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  registerBuffer({ bufferId, size }) {
    const buffer = createSharedBuffer(size);
    state.bufferRegistry.set(bufferId, buffer);
    return { success: true, sab: buffer.sab };
  },

  unregisterBuffer({ bufferId }) {
    state.bufferRegistry.delete(bufferId);
    return { success: true };
  },

  getFilesList() {
    return {
      success: true,
      files: Object.entries(state.metadata.files).map(([name, meta]) => ({
        name,
        mime: meta.mime,
        size: meta.lastSize || 0,
        modified: meta.lastModified || 0,
        versions: meta.headVersion || 0
      }))
    };
  }
};

// Message handling
self.onmessage = async (e) => {
  const { id, type, data } = e.data;

  try {
    const result = await handlers[type]?.(data) || { success: false, error: 'Unknown command' };
    self.postMessage({ id, ...result });
  } catch (error) {
    self.postMessage({ id, success: false, error: error.message });
  }
};