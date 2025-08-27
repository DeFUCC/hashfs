// HashFS Web Worker - Handles crypto, storage, and chain management
import { openDB } from 'idb';
import { cryptoUtils, compress, createChainManager, encoder, decoder } from './crypto.js';

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

      this.chainManager = createChainManager(this.db, this.keys.encKey, undefined, {
        sign: (hash) => this.keys.sign(hash),
        verify: (hash, sig) => this.keys.verify(hash, sig)
      });

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

  async loadFile(filename, version = null) {
    if (!this.auth) throw new Error('Not authenticated');

    const meta = this.metadata.files[filename];
    if (!meta?.activeKey) return { bytes: new Uint8Array(), mime: 'text/plain' };

    try {
      // Get file chain
      const chain = await this.chainManager.getChain(meta.chainId);

      // Determine which version to load
      let targetVersion;
      if (version === null) {
        // Load latest
        targetVersion = chain.versions[chain.versions.length - 1];
      } else {
        // Find specific version
        targetVersion = chain.versions.find(v => v.version === version);
        if (!targetVersion) {
          throw new Error(`Version ${version} not found`);
        }
      }

      const encrypted = await this.db.get('files', targetVersion.key);
      if (!encrypted) {
        if (version === null) {
          // Latest version is corrupted - remove file
          delete this.metadata.files[filename];
          await this.saveMetadata();
        }
        throw new Error(`File "${filename}" version ${version || 'latest'} is corrupted`);
      }

      const decrypted = await cryptoUtils.decrypt(encrypted, this.keys.encKey);
      const inflated = await compress.inflate(decrypted);

      // Verify integrity
      // Use BLAKE3 for hash verification
      const hash = cryptoUtils.hash(inflated);
      if (hash !== targetVersion.hash || !this.keys.verify(hash, targetVersion.sig)) {
        throw new Error('Integrity verification failed');
      }

      // Return transferable buffer with version info
      return {
        bytes: inflated.slice(), // Transfer ownership
        mime: meta.mime,
        size: inflated.length,
        version: targetVersion.version,
        currentVersion: meta.headVersion,
        availableVersions: {
          min: chain.versions[0]?.version || 0,
          max: chain.versions[chain.versions.length - 1]?.version || 0
        }
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


  // Create a zip archive (Uint8Array) of all files in the vault.
  // Posts progress messages using operationId when provided.
  async exportZip(operationId = null) {
    const entries = {};
    const items = Object.entries(this.metadata.files);
    let completed = 0;
    const metaMap = {};

    for (const [name, meta] of items) {
      if (meta.activeKey) {
        try {
          const encrypted = await this.db.get('files', meta.activeKey);
          const decrypted = await cryptoUtils.decrypt(encrypted, this.keys.encKey);
          const content = await compress.inflate(decrypted);

          // Add file content as Uint8Array; ZIP will preserve full path in keys
          entries[name] = new Uint8Array(content);
          // preserve MIME type for round-trip
          metaMap[name] = meta.mime || 'application/octet-stream';
        } catch (e) {
          console.warn(`Export ZIP failed for ${name}:`, e);
        }
      }

      completed++;
      if (operationId) {
        self.postMessage({ type: 'progress', operationId, completed, total: items.length, current: name });
      }
    }

    // Attach metadata manifest so we can restore MIME types on import
    try {
      const metaBytes = encoder.encode(JSON.stringify({ mimes: metaMap }));
      entries['.hashfs_meta.json'] = metaBytes;
    } catch (e) {
      console.warn('Failed to encode export metadata:', e);
    }

    // Create ZIP (Uint8Array)
    const zipped = compress.zip(entries, { level: 6 });
    return zipped; // Uint8Array
  }

  // Import a zip archive (ArrayBuffer) and return array of file entries using
  // the standard transferable interface: [{ name, success, data: { filename, mime, bytes, size } }, ...]
  // Posts progress messages using operationId when provided.
  async importZip(arrayBuffer, operationId = null) {
    const results = [];
    try {
      const u8 = new Uint8Array(arrayBuffer);
      const decompressed = compress.unzip(u8);
      // Parse metadata manifest if present to recover original MIME types
      let metaMap = {};
      if (decompressed['.hashfs_meta.json']) {
        try {
          const raw = decompressed['.hashfs_meta.json'];
          const rawU8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          const parsed = JSON.parse(decoder.decode(rawU8));
          metaMap = parsed && parsed.mimes ? parsed.mimes : {};
        } catch (e) {
          console.warn('Failed to parse ZIP metadata:', e);
        }
      }

      const entries = Object.entries(decompressed);
      let completed = 0;

      for (const [filepath, data] of entries) {
        // skip internal metadata file
        if (filepath === '.hashfs_meta.json') {
          completed++;
          if (operationId) {
            self.postMessage({ type: 'progress', operationId, completed, total: entries.length, current: filepath });
          }
          continue;
        }

        try {
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

          const transferData = {
            filename: filepath,
            mime: metaMap[filepath] || 'application/octet-stream',
            bytes: bytes.buffer,
            size: bytes.length
          };

          results.push({ name: filepath, success: true, data: transferData });
        } catch (err) {
          results.push({ name: filepath, success: false, error: err.message });
        }

        completed++;
        if (operationId) {
          self.postMessage({ type: 'progress', operationId, completed, total: entries.length, current: filepath });
        }
      }
    } catch (error) {
      throw new Error(`ZIP import failed: ${error.message}`);
    }

    return results;
  }

  // Import regular files, each file is { name, bytes, type }
  // Returns array of file entries using the standard transferable interface
  async importFiles(files, operationId = null) {
    const results = [];
    let completed = 0;

    for (const file of files) {
      try {
        const bytes = file.bytes instanceof ArrayBuffer ? file.bytes : new Uint8Array(file.bytes).buffer;

        const transferData = {
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          bytes: bytes,
          size: bytes.byteLength
        };

        results.push({ name: file.name, success: true, data: transferData });
      } catch (err) {
        results.push({ name: file.name, success: false, error: err.message });
      }

      completed++;
      if (operationId) {
        self.postMessage({ type: 'progress', operationId, completed, total: files.length, current: file.name });
      }
    }

    return results;
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
        // forward optional version parameter so the worker can load a specific version
        result = await worker.loadFile(data.filename, data.version);
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
      case 'export-zip':
        // data.operationId is optional; returns a Uint8Array
        result = await worker.exportZip(data?.operationId);
        break;
      case 'import-zip':
        // data.arrayBuffer required; data.operationId optional
        result = await worker.importZip(data.arrayBuffer, data?.operationId);
        break;
      case 'import-files':
        // data.files required; data.operationId optional
        result = await worker.importFiles(data.files, data?.operationId);
        break;
      case 'get-files':
        result = worker.getFileList();
        break;
      default:
        throw new Error(`Unknown operation: ${type}`);
    }

    // Determine transferable objects for the result
    const transferable = [];

    // If result is a Uint8Array (zip), transfer its buffer
    if (result instanceof Uint8Array) {
      transferable.push(result.buffer);
    }

    // If result is an object containing bytes (file load), transfer the ArrayBuffer
    if (result && result.bytes instanceof Uint8Array) {
      transferable.push(result.bytes.buffer);
    }

    // If result is an array of items with data.bytes ArrayBuffer, transfer those
    if (Array.isArray(result)) {
      result.forEach(item => {
        if (item?.data?.bytes instanceof ArrayBuffer) transferable.push(item.data.bytes);
      });
    }

    // If result is an object mapping names to file objects with content arrays, no transfer needed
    self.postMessage({ id, success: true, result }, transferable);

  } catch (error) {
    self.postMessage({
      id,
      success: false,
      error: error.message
    });
  }
};