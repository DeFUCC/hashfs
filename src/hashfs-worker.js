// HashFS Web Worker - Streamlined single-file implementation
import { openDB } from 'idb';
import { cryptoUtils, compress, createChainManager, encoder, decoder } from './crypto.js';

// State variables
let auth = false;
let keys = null;
let db = null;
let chainManager = null;
let metadata = { files: {} };

const DB_VERSION = 2;
const META_VERSION = 6;
const DEFAULT_VERSION_LIMIT = 15;

// Core handlers for all operations
const handlers = {
  async init(passphrase) {
    keys = await cryptoUtils.deriveKeys(passphrase);
    db = await initDatabase(keys.dbName);
    metadata.files = await loadMetadata();

    chainManager = createChainManager(db, keys.encKey, undefined, {
      sign: (hash) => keys.sign(hash),
      verify: (hash, sig) => keys.verify(hash, sig)
    });

    auth = true;

    // Generate vault fingerprint
    const vaultData = new Uint8Array(64);
    vaultData.set(encoder.encode(keys.dbName).slice(0, 32), 0);
    vaultData.set(new Uint8Array(keys.encKey).slice(0, 32), 32);
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
      files: getFileList(),
      messageHash: { base: baseHash, session: sessionHash }
    };
  },

  async load(filename, version = null, validate = false) {
    if (!auth) throw new Error('Not authenticated');

    const meta = metadata.files[filename];
    if (!meta?.activeKey) return { bytes: new Uint8Array(), mime: 'text/markdown' };

    const chain = await chainManager.getChain(meta.chainId);
    let targetVersion = version === null
      ? chain.versions[chain.versions.length - 1]
      : chain.versions.find(v => v.version === version);

    if (!targetVersion) throw new Error(`Version ${version} not found`);

    const encrypted = await db.get('files', targetVersion.key);
    if (!encrypted) {
      // Try to recover from previous version
      if (version === null) {
        const recovered = await recoverFromPreviousVersion(meta, chain);
        if (recovered) {
          await saveMetadata();
          return { ...recovered, mime: meta.mime, currentVersion: meta.headVersion };
        }
        // File is corrupted, remove from metadata
        delete metadata.files[filename];
        await saveMetadata();
      }
      throw new Error(`File "${filename}" version ${version || 'latest'} is corrupted`);
    }

    const decrypted = await cryptoUtils.decrypt(encrypted, keys.encKey);
    const inflated = await compress.inflate(decrypted);

    // Always validate both hash and signature on every read
    const hash = cryptoUtils.hash(inflated);
    if (hash !== targetVersion.hash) {
      throw new Error('Data corruption detected - hash mismatch');
    }
    if (!keys.verify(hash, targetVersion.sig)) {
      throw new Error('Signature verification failed - data may be tampered');
    }

    // Full chain integrity validation if requested
    if (validate) {
      await validateChainIntegrity(chain);
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
  },

  async save(filename, data, options = {}) {
    if (!auth) throw new Error('Not authenticated');

    const { bytes, mime = 'text/markdown' } = data;
    const { versionLimit = DEFAULT_VERSION_LIMIT } = options;
    const fileBytes = new Uint8Array(bytes);
    const hash = cryptoUtils.hash(fileBytes);

    // Initialize metadata if new file
    if (!metadata.files[filename]) {
      metadata.files[filename] = {
        mime,
        chainId: cryptoUtils.generateChainId(),
        headVersion: 0,
        lastModified: Date.now(),
        lastSize: fileBytes.length,
        lastCompressedSize: 0,
        activeKey: null
      };
    }

    const meta = metadata.files[filename];

    // Check if content unchanged
    try {
      const chain = await chainManager.getChain(meta.chainId);
      const latest = chain.versions[chain.versions.length - 1];
      if (latest?.hash === hash) {
        if (meta.mime !== mime) {
          meta.mime = mime;
          await saveMetadata();
        }
        return { success: true, unchanged: true };
      }
    } catch (error) {
      console.warn('Chain verification failed:', error);
    }

    // Save new version
    const sig = keys.sign(hash);
    const key = cryptoUtils.generateKey();
    const version = meta.headVersion + 1;
    const compressed = await compress.deflate(fileBytes);
    const encrypted = await cryptoUtils.encrypt(compressed, keys.encKey);

    const tx = db.transaction(['files', 'meta'], 'readwrite');
    await tx.objectStore('files').put(encrypted, key);

    // Update metadata
    meta.mime = mime;
    meta.headVersion = version;
    meta.lastModified = Date.now();
    meta.lastSize = fileBytes.length;
    meta.lastCompressedSize = compressed.length;
    meta.activeKey = key;

    await saveMetadata(tx);
    await tx.done;

    // Get the chain and add new version
    const chain = await chainManager.getChain(meta.chainId);
    chain.versions.push({
      version, hash, sig, key,
      size: fileBytes.length,
      ts: Date.now()
    });

    // Prune old versions if needed
    const toDelete = [];
    while (chain.versions.length > versionLimit) {
      const old = chain.versions.shift();
      if (old.key) toDelete.push(old.key);
      chain.pruned = chain.pruned || { count: 0, oldestKept: 0 };
      chain.pruned.count++;
    }

    if (chain.versions.length > 0) {
      chain.pruned.oldestKept = chain.versions[0].version;
    }

    // Update chain hash after pruning
    chain.chainHash = computeChainHash(chain.versions);
    chain.chainSig = keys.sign(chain.chainHash);

    // Save updated chain and cleanup in single operation
    await chainManager.saveChain(meta.chainId, chain);

    if (toDelete.length > 0) {
      const cleanupTx = db.transaction(['files'], 'readwrite');
      await Promise.all(toDelete.map(key =>
        cleanupTx.objectStore('files').delete(key).catch(() => { })
      ));
      await cleanupTx.done;
    }

    return {
      success: true,
      files: getFileList(),
      version
    };
  },

  async delete(filename) {
    if (!auth) throw new Error('Not authenticated');

    const meta = metadata.files[filename];
    if (!meta) return { success: true };

    const keysToDelete = [];

    if (meta.chainId) {
      try {
        const chain = await chainManager.getChain(meta.chainId);
        keysToDelete.push(...chain.versions.map(v => v.key).filter(Boolean));
      } catch (e) {
        console.warn('Failed to load chain for deletion:', e);
      }
    }

    if (meta.activeKey) keysToDelete.push(meta.activeKey);

    const tx = db.transaction(['files', 'meta', 'chains'], 'readwrite');

    for (const key of keysToDelete) {
      try { await tx.objectStore('files').delete(key); }
      catch (e) { console.warn('Failed to delete file key:', key); }
    }

    if (meta.chainId) {
      try { await tx.objectStore('chains').delete(meta.chainId); }
      catch (e) { console.warn('Failed to delete chain:', meta.chainId); }
    }

    delete metadata.files[filename];
    await saveMetadata(tx);
    await tx.done;

    return { success: true, files: getFileList() };
  },

  async rename(oldName, newName) {
    if (!auth || !newName || metadata.files[newName]) {
      throw new Error('Invalid rename operation');
    }

    if (!metadata.files[oldName]) {
      throw new Error('File not found');
    }

    metadata.files[newName] = metadata.files[oldName];
    delete metadata.files[oldName];
    await saveMetadata();

    return { success: true, files: getFileList() };
  },

  async exportZip(operationId = null) {
    const entries = {};
    const items = Object.entries(metadata.files);
    let completed = 0;
    const metaMap = {};

    for (const [name, meta] of items) {
      if (meta.activeKey) {
        try {
          const encrypted = await db.get('files', meta.activeKey);
          const decrypted = await cryptoUtils.decrypt(encrypted, keys.encKey);
          const content = await compress.inflate(decrypted);
          entries[name] = new Uint8Array(content);
          metaMap[name] = meta.mime || 'application/octet-stream';
        } catch (e) {
          console.warn(`Export ZIP failed for ${name}:`, e);
        }
      }

      completed++;
      if (operationId) {
        self.postMessage({
          type: 'progress', operationId, completed,
          total: items.length, current: name
        });
      }
    }

    try {
      const metaBytes = encoder.encode(JSON.stringify({ mimes: metaMap }));
      entries['.hashfs_meta.json'] = metaBytes;
    } catch (e) {
      console.warn('Failed to encode export metadata:', e);
    }

    return compress.zip(entries, { level: 6 });
  },

  async importZip(arrayBuffer, operationId = null) {
    const results = [];
    const u8 = new Uint8Array(arrayBuffer);
    const decompressed = compress.unzip(u8);

    let metaMap = {};
    if (decompressed['.hashfs_meta.json']) {
      try {
        const raw = decompressed['.hashfs_meta.json'];
        const rawU8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const parsed = JSON.parse(decoder.decode(rawU8));
        metaMap = parsed?.mimes || {};
      } catch (e) {
        console.warn('Failed to parse ZIP metadata:', e);
      }
    }

    const entries = Object.entries(decompressed);
    let completed = 0;

    for (const [filepath, data] of entries) {
      if (filepath === '.hashfs_meta.json') {
        completed++;
        if (operationId) {
          self.postMessage({
            type: 'progress', operationId, completed,
            total: entries.length, current: filepath
          });
        }
        continue;
      }

      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        results.push({
          name: filepath,
          success: true,
          data: {
            filename: filepath,
            mime: metaMap[filepath] || 'application/octet-stream',
            bytes: bytes.buffer,
            size: bytes.length
          }
        });
      } catch (err) {
        results.push({ name: filepath, success: false, error: err.message });
      }

      completed++;
      if (operationId) {
        self.postMessage({
          type: 'progress', operationId, completed,
          total: entries.length, current: filepath
        });
      }
    }

    return results;
  },

  async importFiles(files, operationId = null) {
    const results = [];
    let completed = 0;

    for (const file of files) {
      try {
        const bytes = file.bytes instanceof ArrayBuffer
          ? file.bytes
          : new Uint8Array(file.bytes).buffer;

        results.push({
          name: file.name,
          success: true,
          data: {
            filename: file.name,
            mime: file.type || 'application/octet-stream',
            bytes: bytes,
            size: bytes.byteLength
          }
        });
      } catch (err) {
        results.push({ name: file.name, success: false, error: err.message });
      }

      completed++;
      if (operationId) {
        self.postMessage({
          type: 'progress', operationId, completed,
          total: files.length, current: file.name
        });
      }
    }

    return results;
  },

  getFiles() {
    return getFileList();
  }
};

// Database initialization
async function initDatabase(dbName) {
  try {
    const db = await openDB(dbName, DB_VERSION, {
      upgrade: (db, oldV, newV, tx) => {
        ['files', 'meta', 'chains'].forEach(store => {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store);
          }
        });

        if (!db.objectStoreNames.contains('integrity')) {
          const store = db.createObjectStore('integrity');
          tx.objectStore('integrity').put(Date.now(), 'created');
          tx.objectStore('integrity').put(META_VERSION, 'metaVersion');
        }
      }
    });

    // Quick health check
    const testKey = `_health_${Date.now()}`;
    const testData = new Uint8Array([1, 2, 3]);
    await db.put('files', testData, testKey);
    const retrieved = await db.get('files', testKey);
    await db.delete('files', testKey);

    if (!retrieved || retrieved.length !== 3) {
      throw new Error('Database health check failed');
    }

    return db;
  } catch (error) {
    console.warn('DB init failed, recovering:', error.message);
    return recoverDatabase(dbName);
  }
}

async function recoverDatabase(dbName) {
  await deleteDatabase(dbName);
  return openDB(dbName, DB_VERSION, {
    upgrade: (db, oldV, newV, tx) => {
      ['files', 'meta', 'chains'].forEach(store => {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store);
        }
      });

      if (!db.objectStoreNames.contains('integrity')) {
        const store = db.createObjectStore('integrity');
        tx.objectStore('integrity').put(Date.now(), 'created');
        tx.objectStore('integrity').put(META_VERSION, 'metaVersion');
      }
    }
  });
}

function deleteDatabase(dbName) {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// Metadata operations
async function loadMetadata() {
  try {
    const encrypted = await db.get('meta', 'index');
    if (!encrypted) return {};

    const decrypted = await cryptoUtils.decrypt(encrypted, keys.encKey);
    const data = JSON.parse(decoder.decode(decrypted));

    if (!isValidMetadata(data)) throw new Error('Invalid structure');
    return migrateMetadata(data).files;
  } catch (error) {
    console.warn('Metadata load failed, rebuilding:', error.message);
    return rebuildMetadata();
  }
}

function isValidMetadata(data) {
  return data &&
    typeof data === 'object' &&
    data.files &&
    typeof data.files === 'object' &&
    Object.values(data.files).every(meta =>
      meta && typeof meta === 'object' && typeof meta.mime === 'string'
    );
}

function migrateMetadata(data) {
  const version = data.schemaVersion || 1;
  if (version >= META_VERSION) return data;

  // Apply migrations
  Object.values(data.files).forEach(meta => {
    if (!meta.lastModified) meta.lastModified = Date.now();
    if (!meta.lastSize) meta.lastSize = 0;
    if (!meta.lastCompressedSize) meta.lastCompressedSize = 0;
    if (!meta.mime) meta.mime = 'text/markdown';
  });

  return { ...data, schemaVersion: META_VERSION };
}

async function rebuildMetadata() {
  const rebuilt = {};

  try {
    const chainKeys = await db.getAllKeys('chains');

    for (const chainId of chainKeys) {
      try {
        const chain = await db.get('chains', chainId);
        if (!chain?.versions?.length) continue;

        const latest = chain.versions[chain.versions.length - 1];
        if (!latest?.key) continue;

        const exists = await db.get('files', latest.key);
        if (!exists) continue;

        rebuilt[`recovered_${chainId.slice(0, 8)}`] = {
          mime: 'application/octet-stream',
          chainId,
          headVersion: latest.version || 0,
          lastModified: latest.ts || Date.now(),
          lastSize: latest.size || 0,
          lastCompressedSize: 0,
          activeKey: latest.key
        };
      } catch (e) {
        // Skip corrupted chain
      }
    }
  } catch (error) {
    console.warn('Metadata rebuild failed:', error);
  }

  return rebuilt;
}

async function saveMetadata(tx = null) {
  const data = {
    files: metadata.files,
    schemaVersion: META_VERSION,
    lastSaved: Date.now()
  };

  if (!isValidMetadata(data)) {
    throw new Error('Invalid metadata structure');
  }

  const bytes = encoder.encode(JSON.stringify(data));
  const encrypted = await cryptoUtils.encrypt(bytes, keys.encKey);

  if (tx) {
    await tx.objectStore('meta').put(encrypted, 'index');
  } else {
    await db.put('meta', encrypted, 'index');
  }
}

// File operations helpers
function getFileList() {
  return Object.entries(metadata.files)
    .map(([name, meta]) => ({
      name,
      mime: meta.mime || 'text/markdown',
      versions: meta.headVersion || 0,
      size: meta.lastSize || 0,
      compressedSize: meta.lastCompressedSize || 0,
      modified: meta.lastModified || 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function recoverFromPreviousVersion(meta, chain) {
  if (!meta.chainId || chain.versions.length < 2) return null;

  // Try previous versions in reverse order
  for (let i = chain.versions.length - 2; i >= 0; i--) {
    const version = chain.versions[i];
    if (!version.key) continue;

    try {
      const encrypted = await db.get('files', version.key);
      if (!encrypted) continue;

      const decrypted = await cryptoUtils.decrypt(encrypted, keys.encKey);
      const inflated = await compress.inflate(decrypted);

      // Update metadata to recovered version
      meta.headVersion = version.version;
      meta.activeKey = version.key;
      meta.lastSize = inflated.length;

      return {
        bytes: inflated,
        version: version.version,
        recovered: true
      };
    } catch (e) {
      // Try next version
    }
  }

  return null;
}

function computeChainHash(versions) {
  if (!versions.length) return cryptoUtils.hash(new Uint8Array());

  // Concatenate all version hashes in sequence
  const hashData = versions.map(v => v.hash).join('');
  return cryptoUtils.hash(encoder.encode(hashData));
}

async function validateChainIntegrity(chain) {
  // Verify chain hash integrity
  if (chain.chainHash && chain.chainSig) {
    const expectedHash = computeChainHash(chain.versions);
    if (expectedHash !== chain.chainHash) {
      throw new Error('Chain hash mismatch - version history corrupted');
    }
    if (!keys.verify(chain.chainHash, chain.chainSig)) {
      throw new Error('Chain signature invalid - version history tampered');
    }
  } else if (chain.versions && chain.versions.length > 0) {
    // Legacy chain without chainHash - compute and add it
    console.warn('Legacy chain detected, computing chain hash...');
    chain.chainHash = computeChainHash(chain.versions);
    chain.chainSig = keys.sign(chain.chainHash);

    // Save the updated chain with chain hash
    try {
      await chainManager.saveChain(chain.chainId || 'unknown', chain);
    } catch (e) {
      console.warn('Failed to save updated chain hash:', e);
    }
  }

  // Verify each version's integrity against stored data
  for (const version of chain.versions) {
    if (!version.key) continue;

    try {
      const encrypted = await db.get('files', version.key);
      if (!encrypted) continue; // Skip missing versions (may be pruned)

      const decrypted = await cryptoUtils.decrypt(encrypted, keys.encKey);
      const inflated = await compress.inflate(decrypted);
      const hash = cryptoUtils.hash(inflated);

      if (hash !== version.hash || !keys.verify(hash, version.sig)) {
        throw new Error(`Version ${version.version} integrity check failed`);
      }
    } catch (error) {
      throw new Error(`Chain validation failed at version ${version.version}: ${error.message}`);
    }
  }
}

async function pruneVersions(chainId, limit) {
  // This function is now inlined in the save handler for better atomicity
  // Keeping as placeholder for potential future use
}

// Worker message handler
self.onmessage = async (e) => {
  const { id, type, data } = e.data;

  try {
    let result;

    switch (type) {
      case 'init':
        result = await handlers.init(data.passphrase);
        break;
      case 'load':
        result = await handlers.load(data.filename, data.version, data.validate);
        break;
      case 'save':
        result = await handlers.save(data.filename, data, data.options);
        break;
      case 'delete':
        result = await handlers.delete(data.filename);
        break;
      case 'rename':
        result = await handlers.rename(data.oldName, data.newName);
        break;
      case 'export-zip':
        result = await handlers.exportZip(data?.operationId);
        break;
      case 'import-zip':
        result = await handlers.importZip(data.arrayBuffer, data?.operationId);
        break;
      case 'import-files':
        result = await handlers.importFiles(data.files, data?.operationId);
        break;
      case 'get-files':
        result = handlers.getFiles();
        break;
      default:
        throw new Error(`Unknown operation: ${type}`);
    }

    // Handle transferable objects
    const transferable = [];
    if (result instanceof Uint8Array) {
      transferable.push(result.buffer);
    }
    if (result?.bytes instanceof Uint8Array) {
      transferable.push(result.bytes.buffer);
    }
    if (Array.isArray(result)) {
      result.forEach(item => {
        if (item?.data?.bytes instanceof ArrayBuffer) {
          transferable.push(item.data.bytes);
        }
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