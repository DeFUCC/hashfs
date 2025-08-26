// HashFS Web Worker - Handles crypto, storage, and chain management
import { openDB } from 'idb';
import { cryptoUtils, compress, createChainManager } from './crypto.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class HashFSWorker {
  constructor() {
    this.auth = false;
    this.keys = null;
    this.db = null;
    this.chainManager = null;
    this.metadata = { files: {} };
    this.fileBuffers = new Map(); // File buffer cache
  }

  async init(passphrase) {
    try {
      this.keys = await cryptoUtils.deriveKeys(passphrase);

      this.db = await openDB(this.keys.dbName, 1, {
        upgrade(database) {
          if (!database.objectStoreNames.contains('files')) database.createObjectStore('files');
          if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta');
          if (!database.objectStoreNames.contains('chains')) database.createObjectStore('chains');
        }
      });

      this.chainManager = createChainManager(this.db, this.keys.encKey);

      // Load metadata
      try {
        const encrypted = await this.db.get('meta', 'index');
        if (encrypted) {
          const decrypted = await cryptoUtils.decrypt(encrypted, this.keys.encKey);
          const data = JSON.parse(decoder.decode(decrypted));
          this.metadata.files = data.files || {};
        }
      } catch (e) {
        console.warn('Metadata load failed:', e);
      }

      await this.cleanup();
      this.auth = true;

      return { success: true, files: this.getFileList() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async loadFile(filename) {
    if (!this.auth) throw new Error('Not authenticated');

    const meta = this.metadata.files[filename];
    if (!meta?.activeKey) return { bytes: new Uint8Array(), mime: 'text/plain' };

    try {
      const encrypted = await this.db.get('files', meta.activeKey);
      if (!encrypted) {
        delete this.metadata.files[filename];
        await this.saveMetadata();
        throw new Error(`File "${filename}" is corrupted`);
      }

      const decrypted = await cryptoUtils.decrypt(encrypted, this.keys.encKey);
      const inflated = await compress.inflate(decrypted);

      // Verify integrity
      const hash = cryptoUtils.hash(inflated);
      const chain = await this.chainManager.getChain(meta.chainId);
      const latest = chain.versions[chain.versions.length - 1];

      if (!latest || hash !== latest.hash || !this.keys.verify(hash, latest.sig)) {
        throw new Error('Integrity verification failed');
      }

      // Return transferable buffer
      return {
        bytes: inflated.slice(), // Transfer ownership
        mime: meta.mime,
        size: inflated.length
      };

    } catch (error) {
      throw new Error(`Load failed: ${error.message}`);
    }
  }

  async saveFile(filename, data) {
    if (!this.auth) return { success: false, error: 'Not authenticated' };

    const { bytes, mime = 'text/plain' } = data;
    const fileBytes = new Uint8Array(bytes);
    const hash = cryptoUtils.hash(fileBytes);

    // Initialize metadata if new file
    if (!this.metadata.files[filename]) {
      this.metadata.files[filename] = {
        mime,
        chainId: cryptoUtils.generateChainId(),
        headVersion: 0,
        lastModified: Date.now(),
        lastSize: fileBytes.length,
        lastCompressedSize: 0,
        activeKey: null
      };
    }

    const meta = this.metadata.files[filename];

    // Check if content unchanged
    try {
      const chain = await this.chainManager.getChain(meta.chainId);
      const latest = chain.versions[chain.versions.length - 1];
      if (latest?.hash === hash) {
        if (meta.mime !== mime) {
          meta.mime = mime;
          await this.saveMetadata();
        }
        return { success: true, unchanged: true };
      }
    } catch (error) {
      console.warn('Chain verification failed:', error);
    }

    try {
      const sig = this.keys.sign(hash);
      const key = cryptoUtils.generateKey();
      const version = meta.headVersion + 1;

      const compressed = await compress.deflate(fileBytes);
      const encrypted = await cryptoUtils.encrypt(compressed, this.keys.encKey);

      // Atomic save
      const tx = this.db.transaction(['files', 'meta'], 'readwrite');
      await tx.objectStore('files').put(encrypted, key);

      // Update metadata
      meta.mime = mime;
      meta.headVersion = version;
      meta.lastModified = Date.now();
      meta.lastSize = fileBytes.length;
      meta.lastCompressedSize = compressed.length;
      meta.activeKey = key;

      await this.saveMetadata(tx);
      await tx.done;

      // Update chain
      await this.chainManager.addVersion(meta.chainId, {
        version, hash, sig, key,
        size: fileBytes.length,
        ts: Date.now()
      });

      return {
        success: true,
        files: this.getFileList(),
        version
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteFile(filename) {
    if (!this.auth) return { success: false, error: 'Not authenticated' };

    const meta = this.metadata.files[filename];
    if (!meta) return { success: true };

    try {
      const keysToDelete = [];
      if (meta.chainId) {
        const chain = await this.chainManager.getChain(meta.chainId);
        keysToDelete.push(...chain.versions.map(v => v.key).filter(Boolean));
      }
      if (meta.activeKey) keysToDelete.push(meta.activeKey);

      const tx = this.db.transaction(['files', 'meta', 'chains'], 'readwrite');

      for (const key of keysToDelete) {
        await tx.objectStore('files').delete(key);
      }

      if (meta.chainId) {
        await tx.objectStore('chains').delete(meta.chainId);
      }

      delete this.metadata.files[filename];
      await this.saveMetadata(tx);
      await tx.done;

      return { success: true, files: this.getFileList() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async renameFile(oldName, newName) {
    if (!this.auth || !newName || this.metadata.files[newName]) {
      return { success: false, error: 'Invalid rename operation' };
    }

    if (!this.metadata.files[oldName]) {
      return { success: false, error: 'File not found' };
    }

    try {
      this.metadata.files[newName] = this.metadata.files[oldName];
      delete this.metadata.files[oldName];
      await this.saveMetadata();

      return { success: true, files: this.getFileList() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async exportAll() {
    const exported = {};

    for (const [name, meta] of Object.entries(this.metadata.files)) {
      if (meta.activeKey) {
        try {
          const encrypted = await this.db.get('files', meta.activeKey);
          const decrypted = await cryptoUtils.decrypt(encrypted, this.keys.encKey);
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

  getFileList() {
    return Object.entries(this.metadata.files).map(([name, meta]) => ({
      name,
      mime: meta.mime || 'text/plain',
      versions: meta.headVersion || 0,
      size: meta.lastSize || 0,
      compressedSize: meta.lastCompressedSize || 0,
      modified: meta.lastModified || 0
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveMetadata(tx = null) {
    const data = { files: this.metadata.files, schemaVersion: 5 };
    const bytes = encoder.encode(JSON.stringify(data));
    const encrypted = await cryptoUtils.encrypt(bytes, this.keys.encKey);

    if (tx) {
      await tx.objectStore('meta').put(encrypted, 'index');
    } else {
      await this.db.put('meta', encrypted, 'index');
    }
  }

  async cleanup() {
    const referenced = new Set();
    const ghostFiles = [];

    for (const [fileName, meta] of Object.entries(this.metadata.files)) {
      let hasValidContent = false;

      if (meta.chainId) {
        try {
          const chain = await this.chainManager.getChain(meta.chainId);
          chain.versions.forEach(v => {
            if (v.key) {
              referenced.add(v.key);
              hasValidContent = true;
            }
          });
        } catch (error) {
          console.warn(`Chain load failed for ${fileName}:`, error);
        }
      }

      if (meta.activeKey) {
        try {
          const exists = await this.db.get('files', meta.activeKey);
          if (exists) {
            referenced.add(meta.activeKey);
            hasValidContent = true;
          }
        } catch (error) {
          console.warn(`ActiveKey check failed for ${fileName}:`, error);
        }
      }

      if (!hasValidContent && (meta.activeKey || meta.headVersion > 0)) {
        ghostFiles.push(fileName);
      }
    }

    if (ghostFiles.length > 0) {
      ghostFiles.forEach(name => delete this.metadata.files[name]);
      await this.saveMetadata();
    }

    // Cleanup orphaned files
    const allKeys = await this.db.getAllKeys('files');
    const orphaned = allKeys.filter(key => !referenced.has(key));

    if (orphaned.length > 0) {
      const tx = this.db.transaction(['files'], 'readwrite');
      for (const key of orphaned) {
        try { await tx.objectStore('files').delete(key); }
        catch (e) { console.warn('Cleanup failed for:', key, e); }
      }
      await tx.done;
    }
  }
}

// Worker message handler
const worker = new HashFSWorker();

self.onmessage = async (e) => {
  const { id, type, data } = e.data;

  try {
    let result;

    switch (type) {
      case 'init':
        result = await worker.init(data.passphrase);
        break;
      case 'load':
        result = await worker.loadFile(data.filename);
        break;
      case 'save':
        result = await worker.saveFile(data.filename, data);
        break;
      case 'delete':
        result = await worker.deleteFile(data.filename);
        break;
      case 'rename':
        result = await worker.renameFile(data.oldName, data.newName);
        break;
      case 'export-all':
        result = await worker.exportAll();
        break;
      case 'get-files':
        result = worker.getFileList();
        break;
      default:
        throw new Error(`Unknown operation: ${type}`);
    }

    // Send result with transferable objects when possible
    const transferable = [];
    if (result.bytes && result.bytes.buffer) {
      transferable.push(result.bytes.buffer);
    }

    self.postMessage({ id, success: true, result }, transferable);

  } catch (error) {
    self.postMessage({
      id,
      success: false,
      error: error.message
    });
  }
};