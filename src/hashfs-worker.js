// HashFS Web Worker - Streamlined with VaultManager
import { cryptoUtils, compress, createChainManager, encoder, decoder } from './crypto.js';
import { VaultManager } from './VaultManager.js';

class HashFSWorker {
  constructor() {
    this.auth = false;
    this.keys = null;
    this.db = null;
    this.chainManager = null;
    this.metadata = { files: {} };
    this.vaultManager = new VaultManager();
  }

  async init(passphrase) {
    try {
      this.keys = await cryptoUtils.deriveKeys(passphrase);

      // Use VaultManager for robust database initialization
      const { db, metadata } = await this.vaultManager.initVault(this.keys);
      this.db = db;
      this.metadata.files = metadata;

      this.chainManager = createChainManager(this.db, this.keys.encKey, undefined, {
        sign: (hash) => this.keys.sign(hash),
        verify: (hash, sig) => this.keys.verify(hash, sig)
      });

      this.auth = true;

      // Generate vault fingerprint
      const vaultData = new Uint8Array(64);
      vaultData.set(encoder.encode(this.keys.dbName).slice(0, 32), 0);
      vaultData.set(new Uint8Array(this.keys.encKey).slice(0, 32), 32);
      const baseHash = cryptoUtils.hash(vaultData);

      const entropy = new Uint8Array(40);
      new DataView(entropy.buffer).setBigInt64(0, BigInt(Date.now()), true);
      crypto.getRandomValues(entropy.subarray(8));

      const sessionData = new Uint8Array(baseHash.length + entropy.length);
      sessionData.set(new Uint8Array(baseHash), 0);
      sessionData.set(entropy, baseHash.length);
      const sessionHash = cryptoUtils.hash(sessionData);

      return {
        success: true,
        files: this.getFileList(),
        messageHash: { base: baseHash, session: sessionHash },
        recoveryInfo: this.vaultManager.getRecoveryInfo()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async loadFile(filename, version = null) {
    if (!this.auth) throw new Error('Not authenticated');

    const meta = this.metadata.files[filename];
    if (!meta?.activeKey) return { bytes: new Uint8Array(), mime: 'text/markdown' };

    try {
      const chain = await this.chainManager.getChain(meta.chainId);

      let targetVersion;
      if (version === null) {
        targetVersion = chain.versions[chain.versions.length - 1];
      } else {
        targetVersion = chain.versions.find(v => v.version === version);
        if (!targetVersion) throw new Error(`Version ${version} not found`);
      }

      const encrypted = await this.db.get('files', targetVersion.key);
      if (!encrypted) {
        // Attempt recovery using VaultManager
        if (version === null) {
          const recovered = await this.vaultManager.recoverFileFromPreviousVersion(
            this.db, meta, this.keys.encKey
          );

          if (recovered) {
            await this.saveMetadata();
            return {
              ...recovered,
              mime: meta.mime,
              currentVersion: meta.headVersion,
              availableVersions: {
                min: chain.versions[0]?.version || 0,
                max: meta.headVersion
              }
            };
          }

          delete this.metadata.files[filename];
          await this.saveMetadata();
        }
        throw new Error(`File "${filename}" version ${version || 'latest'} is corrupted`);
      }

      const decrypted = await cryptoUtils.decrypt(encrypted, this.keys.encKey);
      const inflated = await compress.inflate(decrypted);

      const hash = cryptoUtils.hash(inflated);
      if (hash !== targetVersion.hash || !this.keys.verify(hash, targetVersion.sig)) {
        throw new Error('Integrity verification failed');
      }

      return {
        bytes: inflated.slice(),
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

    const { bytes, mime = 'text/markdown' } = data;
    const fileBytes = new Uint8Array(bytes);
    const hash = cryptoUtils.hash(fileBytes);

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
    } catch (error) { console.warn('Chain verification failed:', error); }

    try {
      const sig = this.keys.sign(hash);
      const key = cryptoUtils.generateKey();
      const version = meta.headVersion + 1;

      const compressed = await compress.deflate(fileBytes);
      const encrypted = await cryptoUtils.encrypt(compressed, this.keys.encKey);

      const tx = this.db.transaction(['files', 'meta'], 'readwrite');
      await tx.objectStore('files').put(encrypted, key);

      meta.mime = mime;
      meta.headVersion = version;
      meta.lastModified = Date.now();
      meta.lastSize = fileBytes.length;
      meta.lastCompressedSize = compressed.length;
      meta.activeKey = key;

      await this.saveMetadata(tx);
      await tx.done;

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
          entries[name] = new Uint8Array(content);
          metaMap[name] = meta.mime || 'application/octet-stream';
        } catch (e) { console.warn(`Export ZIP failed for ${name}:`, e); }
      }

      completed++;
      if (operationId) {
        self.postMessage({ type: 'progress', operationId, completed, total: items.length, current: name });
      }
    }

    try {
      const metaBytes = encoder.encode(JSON.stringify({ mimes: metaMap }));
      entries['.hashfs_meta.json'] = metaBytes;
    } catch (e) {
      console.warn('Failed to encode export metadata:', e);
    }

    const zipped = compress.zip(entries, { level: 6 });
    return zipped;
  }

  async importZip(arrayBuffer, operationId = null) {
    const results = [];
    try {
      const u8 = new Uint8Array(arrayBuffer);
      const decompressed = compress.unzip(u8);
      let metaMap = {};
      if (decompressed['.hashfs_meta.json']) {
        try {
          const raw = decompressed['.hashfs_meta.json'];
          const rawU8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          const parsed = JSON.parse(decoder.decode(rawU8));
          metaMap = parsed && parsed.mimes ? parsed.mimes : {};
        } catch (e) { console.warn('Failed to parse ZIP metadata:', e); }
      }

      const entries = Object.entries(decompressed);
      let completed = 0;

      for (const [filepath, data] of entries) {
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
        } catch (err) { results.push({ name: filepath, success: false, error: err.message }); }

        completed++;
        if (operationId) {
          self.postMessage({ type: 'progress', operationId, completed, total: entries.length, current: filepath });
        }
      }
    } catch (error) { throw new Error(`ZIP import failed: ${error.message}`); }

    return results;
  }

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
      mime: meta.mime || 'text/markdown',
      versions: meta.headVersion || 0,
      size: meta.lastSize || 0,
      compressedSize: meta.lastCompressedSize || 0,
      modified: meta.lastModified || 0
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveMetadata(tx = null) {
    await this.vaultManager.saveMetadata(this.db, this.metadata.files, this.keys.encKey, tx);
  }

  // Manual integrity check operation
  async runIntegrityCheck() {
    if (!this.auth) return { success: false, error: 'Not authenticated' };

    try {
      const result = await this.vaultManager.performFullIntegrityCheck(
        this.db, this.metadata, this.keys.encKey, this.keys
      );

      // Save updated metadata after cleanup
      if (result.filesRemoved.length > 0) {
        await this.saveMetadata();
      }

      return {
        success: true,
        result,
        files: this.getFileList()
      };
    } catch (error) {
      return { success: false, error: error.message };
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
        result = await worker.exportZip(data?.operationId);
        break;
      case 'import-zip':
        result = await worker.importZip(data.arrayBuffer, data?.operationId);
        break;
      case 'import-files':
        result = await worker.importFiles(data.files, data?.operationId);
        break;
      case 'get-files':
        result = worker.getFileList();
        break;
      case 'integrity-check':
        result = await worker.runIntegrityCheck();
        break;
      default:
        throw new Error(`Unknown operation: ${type}`);
    }

    const transferable = [];

    if (result instanceof Uint8Array) {
      transferable.push(result.buffer);
    }

    if (result && result.bytes instanceof Uint8Array) {
      transferable.push(result.bytes.buffer);
    }

    if (Array.isArray(result)) {
      result.forEach(item => {
        if (item?.data?.bytes instanceof ArrayBuffer) transferable.push(item.data.bytes);
      });
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