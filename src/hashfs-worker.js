// HashFS Web Worker - Ultra-compact modular implementation
import { openDB } from 'idb';
import { deflate, inflate, zipSync, unzipSync } from 'fflate';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { blake3 } from '@noble/hashes/blake3';
import { hkdf } from '@noble/hashes/hkdf';

const [encoder, decoder] = [new TextEncoder(), new TextDecoder()];

// ==============
// VERSIONED STATE & CONFIGURATION
// ==============

const VERSION_CONFIG = {
  // Core versioning - increment these to trigger upgrades
  CRYPTO_VERSION: 6,      // Changes require full vault rebuild
  DB_VERSION: 2,          // Database schema changes
  META_VERSION: 6,        // Metadata structure changes
  CHAIN_VERSION: 1,       // Chain format changes

  // Derived version strings - auto-generated from versions above
  get SALT_BASE() { return `hashfs-v${this.CRYPTO_VERSION}-2025` },
  get DB_SUFFIX() { return `-hashfs-v${this.CRYPTO_VERSION}` },

  // Operational constants
  DEFAULT_VERSION_LIMIT: 15,
  MAX_CACHE_SIZE: 20,
  MIN_PASSWORD_LENGTH: 8,

  // Crypto parameters
  SCRYPT: { N: 1 << 17, r: 8, p: 1, dkLen: 32 },
  get SCRYPT_MAXMEM() { return this.SCRYPT.N * this.SCRYPT.r * this.SCRYPT.p * 128 + (128 * this.SCRYPT.r * this.SCRYPT.p) }
};

let [auth, keys, db, chainManager, metadata] = [false, null, null, null, { files: {} }];

// ==============
// CRYPTOGRAPHY MODULE
// ==============

const crypto = {
  async deriveKeys(pwd) {
    const pwdBytes = encoder.encode(String(pwd || '').normalize('NFC').trim());
    if (pwdBytes.length < VERSION_CONFIG.MIN_PASSWORD_LENGTH) throw new Error('Password too short');

    const salt = encoder.encode(VERSION_CONFIG.SALT_BASE);
    const masterKey = scrypt(pwdBytes, salt, { ...VERSION_CONFIG.SCRYPT, maxmem: VERSION_CONFIG.SCRYPT_MAXMEM });
    const [sigKey, encKey] = [
      hkdf(sha256, masterKey, salt, encoder.encode('signing'), 32),
      hkdf(sha256, masterKey, salt, encoder.encode('encryption'), 32)
    ];
    const pubKey = ed25519.getPublicKey(sigKey);

    return {
      sigKey, pubKey, encKey,
      dbName: bytesToHex(blake3(pubKey).slice(0, 16)) + VERSION_CONFIG.DB_SUFFIX,
      sign: hash => bytesToHex(ed25519.sign(hexToBytes(hash), sigKey)),
      verify: (hash, sig) => { try { return ed25519.verify(hexToBytes(sig), hexToBytes(hash), pubKey) } catch { return false } }
    };
  },

  hash: bytes => bytesToHex(blake3(bytes)),
  generateKey: () => 'sk_' + bytesToHex(randomBytes(12)),
  generateChainId: () => bytesToHex(randomBytes(16)).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),

  async encrypt(bytes, keyBytes) {
    const iv = randomBytes(12);
    return { iv, data: gcm(keyBytes, iv).encrypt(bytes) };
  },

  decrypt: (payload, keyBytes) => new Uint8Array(gcm(keyBytes, payload.iv).decrypt(payload.data))
};

// ==============
// COMPRESSION MODULE
// ==============

const compress = {
  deflate: bytes => new Promise((resolve, reject) => deflate(bytes, (err, result) => err ? reject(err) : resolve(result))),
  inflate: bytes => new Promise((resolve, reject) => inflate(bytes, (err, result) => err ? reject(err) : resolve(result))),
  zip: zipSync,
  unzip: unzipSync
};

// ==============
// VAULT MANAGEMENT MODULE  
// ==============

const vault = {
  async init(passphrase) {
    keys = await crypto.deriveKeys(passphrase);
    db = await openDB(keys.dbName, VERSION_CONFIG.DB_VERSION, {
      upgrade: db => ['files', 'meta', 'chains', 'integrity'].forEach(store => {
        if (!db.objectStoreNames.contains(store)) {
          const objStore = db.createObjectStore(store);
          if (store === 'integrity') {
            objStore.put(Date.now(), 'created');
            objStore.put(VERSION_CONFIG.META_VERSION, 'metaVersion');
          }
        }
      })
    }).catch(async error => {
      console.warn('DB init failed, recovering:', error.message);
      await new Promise(resolve => {
        const req = indexedDB.deleteDatabase(keys.dbName);
        req.onsuccess = req.onerror = req.onblocked = resolve;
      });
      return openDB(keys.dbName, VERSION_CONFIG.DB_VERSION, { upgrade: db => ['files', 'meta', 'chains', 'integrity'].forEach(store => db.createObjectStore(store)) });
    });

    // Health check
    const testKey = `_health_${Date.now()}`, testData = new Uint8Array([1, 2, 3]);
    await db.put('files', testData, testKey);
    const retrieved = await db.get('files', testKey);
    await db.delete('files', testKey);
    if (!retrieved || retrieved.length !== 3) throw new Error('Database health check failed');

    metadata.files = await this.loadMetadata();
    chainManager = chains.create();
    auth = true;

    // Generate vault fingerprint
    const vaultData = new Uint8Array(64);
    vaultData.set(encoder.encode(keys.dbName).slice(0, 32), 0);
    vaultData.set(new Uint8Array(keys.encKey).slice(0, 32), 32);
    const baseHash = crypto.hash(vaultData);

    const entropy = new Uint8Array(40);
    new DataView(entropy.buffer).setBigInt64(0, BigInt(Date.now()), true);
    globalThis.crypto.getRandomValues(entropy.subarray(8));
    const sessionData = new Uint8Array([...baseHash, ...entropy]);

    return {
      success: true,
      files: this.getFileList(),
      messageHash: { base: baseHash, session: crypto.hash(sessionData) }
    };
  },

  async loadMetadata() {
    try {
      const encrypted = await db.get('meta', 'index');
      if (!encrypted) return {};

      const data = JSON.parse(decoder.decode(await crypto.decrypt(encrypted, keys.encKey)));
      if (!data?.files || typeof data.files !== 'object' ||
        !Object.values(data.files).every(meta => meta && typeof meta.mime === 'string')) {
        throw new Error('Invalid structure');
      }

      // Auto-migrate metadata if needed
      const version = data.schemaVersion || 1;
      if (version < VERSION_CONFIG.META_VERSION) {
        Object.values(data.files).forEach(meta => Object.assign(meta, {
          lastModified: meta.lastModified || Date.now(),
          lastSize: meta.lastSize || 0,
          lastCompressedSize: meta.lastCompressedSize || 0,
          mime: meta.mime || 'text/markdown'
        }));
        return { ...data, schemaVersion: VERSION_CONFIG.META_VERSION }.files;
      }
      return data.files;
    } catch (error) {
      console.warn('Metadata load failed, rebuilding:', error.message);
      // Rebuild from chains
      const rebuilt = {};
      try {
        for (const chainId of await db.getAllKeys('chains')) {
          try {
            const chain = await db.get('chains', chainId);
            const latest = chain?.versions?.[chain.versions.length - 1];
            if (latest?.key && await db.get('files', latest.key)) {
              rebuilt[`recovered_${chainId.slice(0, 8)}`] = {
                mime: 'application/octet-stream', chainId, activeKey: latest.key,
                headVersion: latest.version || 0, lastModified: latest.ts || Date.now(),
                lastSize: latest.size || 0, lastCompressedSize: 0
              };
            }
          } catch { } // Skip corrupted chains
        }
      } catch (error) {
        console.warn('Metadata rebuild failed:', error);
      }
      return rebuilt;
    }
  },

  async saveMetadata(tx) {
    const data = { files: metadata.files, schemaVersion: VERSION_CONFIG.META_VERSION, lastSaved: Date.now() };
    const encrypted = await crypto.encrypt(encoder.encode(JSON.stringify(data)), keys.encKey);
    await (tx?.objectStore('meta') || db).put(encrypted, 'index');
  },

  getFileList: () => Object.entries(metadata.files)
    .map(([name, meta]) => ({
      name, mime: meta.mime || 'text/markdown', versions: meta.headVersion || 0,
      size: meta.lastSize || 0, compressedSize: meta.lastCompressedSize || 0,
      modified: meta.lastModified || 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
};

// ==============
// CHAIN MANAGEMENT MODULE
// ==============

const chains = {
  create() {
    const cache = new Map();
    const computeHash = versions => versions.length ?
      crypto.hash(encoder.encode(versions.map(v => v.hash).join(''))) :
      crypto.hash(new Uint8Array());

    return {
      async getChain(chainId) {
        if (cache.has(chainId)) {
          const cached = cache.get(chainId);
          cache.delete(chainId); cache.set(chainId, cached); // LRU
          return cached;
        }

        try {
          const stored = await db.get('chains', chainId);
          if (!stored) return { versions: [], pruned: { count: 0, oldestKept: 0 } };

          if (!stored.sig) throw new Error('Missing chain signature');
          const decrypted = await crypto.decrypt(stored, keys.encKey);
          if (!keys.verify(crypto.hash(decrypted), stored.sig)) throw new Error('Chain signature verification failed');

          const chain = JSON.parse(decoder.decode(await compress.inflate(decrypted)));

          if (cache.size >= VERSION_CONFIG.MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
          cache.set(chainId, chain);
          return chain;
        } catch (error) {
          console.warn('Chain load failed:', chainId, error);
          return { versions: [], pruned: { count: 0, oldestKept: 0 } };
        }
      },

      async saveChain(chainId, chain) {
        const compressed = await compress.deflate(encoder.encode(JSON.stringify(chain)));
        const encrypted = await crypto.encrypt(compressed, keys.encKey);
        encrypted.sig = keys.sign(crypto.hash(compressed));

        await db.put('chains', encrypted, chainId);
        if (cache.size >= VERSION_CONFIG.MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
        cache.set(chainId, chain);
      },

      async validateIntegrity(chain) {
        // Verify chain hash
        if (chain.chainHash && chain.chainSig) {
          const expectedHash = computeHash(chain.versions);
          if (expectedHash !== chain.chainHash || !keys.verify(chain.chainHash, chain.chainSig)) {
            throw new Error('Chain integrity verification failed');
          }
        } else if (chain.versions?.length > 0) {
          console.warn('Legacy chain detected, computing chain hash...');
          chain.chainHash = computeHash(chain.versions);
          chain.chainSig = keys.sign(chain.chainHash);
        }

        // Verify each version
        for (const version of chain.versions) {
          if (!version.key) continue;
          try {
            const encrypted = await db.get('files', version.key);
            if (!encrypted) continue; // Skip pruned versions
            const inflated = await compress.inflate(await crypto.decrypt(encrypted, keys.encKey));
            const hash = crypto.hash(inflated);
            if (hash !== version.hash || !keys.verify(hash, version.sig)) {
              throw new Error(`Version ${version.version} integrity check failed`);
            }
          } catch (error) {
            throw new Error(`Chain validation failed at version ${version.version}: ${error.message}`);
          }
        }
      },

      computeHash
    };
  }
};

// ==============
// OPERATIONS MODULE
// ==============

const ops = {
  async load(filename, version = null, validate = false) {
    if (!auth) throw new Error('Not authenticated');

    const meta = metadata.files[filename];
    if (!meta?.activeKey) return { bytes: new Uint8Array(), mime: 'text/markdown' };

    const chain = await chainManager.getChain(meta.chainId);
    const targetVersion = version === null ?
      chain.versions[chain.versions.length - 1] :
      chain.versions.find(v => v.version === version);

    if (!targetVersion) throw new Error(`Version ${version} not found`);

    let encrypted = await db.get('files', targetVersion.key);
    if (!encrypted && version === null) {
      // Try recovery from previous versions
      for (let i = chain.versions.length - 2; i >= 0; i--) {
        const v = chain.versions[i];
        if (!v.key) continue;
        try {
          encrypted = await db.get('files', v.key);
          if (encrypted) {
            const inflated = await compress.inflate(await crypto.decrypt(encrypted, keys.encKey));
            Object.assign(meta, { headVersion: v.version, activeKey: v.key, lastSize: inflated.length });
            await vault.saveMetadata();
            return { bytes: inflated, mime: meta.mime, currentVersion: meta.headVersion, recovered: true };
          }
        } catch { }
      }
      // No recovery possible, remove corrupted file
      delete metadata.files[filename];
      await vault.saveMetadata();
    }

    if (!encrypted) throw new Error(`File "${filename}" version ${version || 'latest'} is corrupted`);

    const inflated = await compress.inflate(await crypto.decrypt(encrypted, keys.encKey));
    const hash = crypto.hash(inflated);

    if (hash !== targetVersion.hash || !keys.verify(hash, targetVersion.sig)) {
      throw new Error('Data corruption or tampering detected');
    }

    if (validate) await chainManager.validateIntegrity(chain);

    return {
      bytes: inflated.slice(), mime: meta.mime, size: inflated.length,
      version: targetVersion.version, currentVersion: meta.headVersion,
      availableVersions: {
        min: chain.versions[0]?.version || 0,
        max: chain.versions[chain.versions.length - 1]?.version || 0
      }
    };
  },

  async save(filename, { bytes, mime = 'text/markdown' }, { versionLimit = VERSION_CONFIG.DEFAULT_VERSION_LIMIT } = {}) {
    if (!auth) throw new Error('Not authenticated');

    const fileBytes = new Uint8Array(bytes);
    const hash = crypto.hash(fileBytes);

    // Initialize or get metadata
    const meta = metadata.files[filename] = metadata.files[filename] || {
      mime, chainId: crypto.generateChainId(), headVersion: 0,
      lastModified: Date.now(), lastSize: fileBytes.length, lastCompressedSize: 0, activeKey: null
    };

    // Check if unchanged
    try {
      const chain = await chainManager.getChain(meta.chainId);
      const latest = chain.versions[chain.versions.length - 1];
      if (latest?.hash === hash) {
        if (meta.mime !== mime) { meta.mime = mime; await vault.saveMetadata(); }
        return { success: true, unchanged: true };
      }
    } catch (error) {
      console.warn('Chain verification failed:', error);
    }

    // Save new version
    const [sig, key, version] = [keys.sign(hash), crypto.generateKey(), meta.headVersion + 1];
    const compressed = await compress.deflate(fileBytes);
    const encrypted = await crypto.encrypt(compressed, keys.encKey);

    const tx = db.transaction(['files', 'meta'], 'readwrite');
    await tx.objectStore('files').put(encrypted, key);

    Object.assign(meta, {
      mime, headVersion: version, lastModified: Date.now(),
      lastSize: fileBytes.length, lastCompressedSize: compressed.length, activeKey: key
    });

    await vault.saveMetadata(tx);
    await tx.done;

    // Update chain
    const chain = await chainManager.getChain(meta.chainId);
    chain.versions.push({ version, hash, sig, key, size: fileBytes.length, ts: Date.now() });

    // Prune old versions
    const toDelete = [];
    while (chain.versions.length > versionLimit) {
      const old = chain.versions.shift();
      if (old.key) toDelete.push(old.key);
      chain.pruned = chain.pruned || { count: 0, oldestKept: 0 };
      chain.pruned.count++;
    }

    if (chain.versions.length > 0) chain.pruned.oldestKept = chain.versions[0].version;

    // Update chain integrity
    chain.chainHash = chainManager.computeHash(chain.versions);
    chain.chainSig = keys.sign(chain.chainHash);

    await chainManager.saveChain(meta.chainId, chain);

    // Cleanup old versions
    if (toDelete.length > 0) {
      const cleanupTx = db.transaction(['files'], 'readwrite');
      await Promise.all(toDelete.map(key => cleanupTx.objectStore('files').delete(key).catch(() => { })));
      await cleanupTx.done;
    }

    return { success: true, files: vault.getFileList(), version };
  },

  async delete(filename) {
    if (!auth) throw new Error('Not authenticated');
    const meta = metadata.files[filename];
    if (!meta) return { success: true };

    // Collect all keys to delete
    const keysToDelete = meta.activeKey ? [meta.activeKey] : [];
    if (meta.chainId) {
      try {
        const chain = await chainManager.getChain(meta.chainId);
        keysToDelete.push(...chain.versions.map(v => v.key).filter(Boolean));
      } catch { }
    }

    // Delete everything in one transaction
    const tx = db.transaction(['files', 'meta', 'chains'], 'readwrite');
    await Promise.all([
      ...keysToDelete.map(key => tx.objectStore('files').delete(key).catch(() => { })),
      meta.chainId ? tx.objectStore('chains').delete(meta.chainId).catch(() => { }) : Promise.resolve()
    ]);

    delete metadata.files[filename];
    await vault.saveMetadata(tx);
    await tx.done;

    return { success: true, files: vault.getFileList() };
  },

  async rename(oldName, newName) {
    if (!auth || !newName || metadata.files[newName] || !metadata.files[oldName]) {
      throw new Error('Invalid rename operation');
    }

    metadata.files[newName] = metadata.files[oldName];
    delete metadata.files[oldName];
    await vault.saveMetadata();
    return { success: true, files: vault.getFileList() };
  },

  // Import/Export operations
  async exportZip(operationId) {
    const [entries, metaMap] = [{}, {}];
    const items = Object.entries(metadata.files);

    for (let i = 0; i < items.length; i++) {
      const [name, meta] = items[i];
      if (meta.activeKey) {
        try {
          const encrypted = await db.get('files', meta.activeKey);
          const content = await compress.inflate(await crypto.decrypt(encrypted, keys.encKey));
          entries[name] = new Uint8Array(content);
          metaMap[name] = meta.mime || 'application/octet-stream';
        } catch (e) {
          console.warn(`Export ZIP failed for ${name}:`, e);
        }
      }

      if (operationId) {
        self.postMessage({ type: 'progress', operationId, completed: i + 1, total: items.length, current: name });
      }
    }

    try {
      entries['.hashfs_meta.json'] = encoder.encode(JSON.stringify({ mimes: metaMap }));
    } catch (e) {
      console.warn('Failed to encode export metadata:', e);
    }

    return compress.zip(entries, { level: 6 });
  },

  async importZip(arrayBuffer, operationId) {
    const decompressed = compress.unzip(new Uint8Array(arrayBuffer));

    // Extract metadata
    let metaMap = {};
    if (decompressed['.hashfs_meta.json']) {
      try {
        const raw = decompressed['.hashfs_meta.json'];
        const parsed = JSON.parse(decoder.decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw)));
        metaMap = parsed?.mimes || {};
      } catch (e) {
        console.warn('Failed to parse ZIP metadata:', e);
      }
    }

    const entries = Object.entries(decompressed);
    const results = [];

    for (let i = 0; i < entries.length; i++) {
      const [filepath, data] = entries[i];

      if (filepath === '.hashfs_meta.json') {
        if (operationId) {
          self.postMessage({ type: 'progress', operationId, completed: i + 1, total: entries.length, current: filepath });
        }
        continue;
      }

      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        results.push({
          name: filepath, success: true,
          data: {
            filename: filepath, mime: metaMap[filepath] || 'application/octet-stream',
            bytes: bytes.buffer, size: bytes.length
          }
        });
      } catch (err) {
        results.push({ name: filepath, success: false, error: err.message });
      }

      if (operationId) {
        self.postMessage({ type: 'progress', operationId, completed: i + 1, total: entries.length, current: filepath });
      }
    }

    return results;
  },

  async importFiles(files, operationId) {
    const results = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const bytes = file.bytes instanceof ArrayBuffer ? file.bytes : new Uint8Array(file.bytes).buffer;
        results.push({
          name: file.name, success: true,
          data: {
            filename: file.name, mime: file.type || 'application/octet-stream',
            bytes: bytes, size: bytes.byteLength
          }
        });
      } catch (err) {
        results.push({ name: file.name, success: false, error: err.message });
      }

      if (operationId) {
        self.postMessage({ type: 'progress', operationId, completed: i + 1, total: files.length, current: file.name });
      }
    }

    return results;
  }
};

// ==============
// MESSAGE HANDLER
// ==============

const handlers = {
  init: data => vault.init(data.passphrase),
  load: data => ops.load(data.filename, data.version, data.validate),
  save: data => ops.save(data.filename, data, data.options),
  delete: data => ops.delete(data.filename),
  rename: data => ops.rename(data.oldName, data.newName),
  'export-zip': data => ops.exportZip(data?.operationId),
  'import-zip': data => ops.importZip(data.arrayBuffer, data?.operationId),
  'import-files': data => ops.importFiles(data.files, data?.operationId),
  'get-files': () => vault.getFileList()
};

self.onmessage = async ({ data: { id, type, data } }) => {
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`Unknown operation: ${type}`);

    const result = await handler(data);

    // Handle transferable objects
    const transferable = [];
    if (result instanceof Uint8Array) transferable.push(result.buffer);
    if (result?.bytes instanceof Uint8Array) transferable.push(result.bytes.buffer);
    if (Array.isArray(result)) {
      result.forEach(item => {
        if (item?.data?.bytes instanceof ArrayBuffer) transferable.push(item.data.bytes);
      });
    }

    self.postMessage({ id, success: true, result }, transferable);
  } catch (error) {
    self.postMessage({ id, success: false, error: error.message });
  }
};