// VaultManager.js - Handles database resilience and recovery
import { openDB } from 'idb';
import { cryptoUtils, compress, encoder, decoder } from './crypto.js';

export class VaultManager {
  constructor() {
    this.dbVersion = 2;
    this.metadataVersion = 6;
    this.recoveryInfo = null;
  }

  async initVault(keys) {
    const db = await this.initDatabase(keys.dbName);
    const metadata = await this.loadMetadata(db, keys.encKey);
    await this.performQuickIntegrityCheck(db, metadata, keys.encKey);
    return { db, metadata: metadata.files };
  }

  async initDatabase(dbName) {
    try {
      const db = await openDB(dbName, this.dbVersion, {
        upgrade: (db, oldV, newV, tx) => this.upgradeSchema(db, oldV, newV, tx)
      });
      await this.testDbHealth(db);
      return db;
    } catch (error) {
      console.warn('DB init failed, recovering:', error.message);
      return this.recoverDatabase(dbName);
    }
  }

  upgradeSchema(db, oldVersion, newVersion, tx) {
    ['files', 'meta', 'chains'].forEach(store => {
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    });

    if (!db.objectStoreNames.contains('integrity')) {
      const store = db.createObjectStore('integrity');
      tx.objectStore('integrity').put(Date.now(), 'created');
      tx.objectStore('integrity').put(this.metadataVersion, 'metaVersion');
    }
  }

  async testDbHealth(db) {
    const testKey = `_health_${Date.now()}`;
    const testData = new Uint8Array([1, 2, 3]);

    await db.put('files', testData, testKey);
    const retrieved = await db.get('files', testKey);
    await db.delete('files', testKey);

    if (!retrieved || retrieved.length !== 3) {
      throw new Error('Database health check failed');
    }
  }

  async recoverDatabase(dbName) {
    await this.deleteDatabase(dbName);
    const db = await openDB(dbName, this.dbVersion, {
      upgrade: (db, oldV, newV, tx) => this.upgradeSchema(db, oldV, newV, tx)
    });

    this.recoveryInfo = {
      timestamp: Date.now(),
      action: 'Fresh database created after corruption'
    };

    return db;
  }

  deleteDatabase(dbName) {
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }

  async loadMetadata(db, encKey) {
    try {
      const encrypted = await db.get('meta', 'index');
      if (!encrypted) return { files: {} };

      const decrypted = await cryptoUtils.decrypt(encrypted, encKey);
      const data = JSON.parse(decoder.decode(decrypted));

      if (!this.isValidMetadata(data)) throw new Error('Invalid structure');

      return this.migrateMetadata(data);
    } catch (error) {
      console.warn('Metadata load failed, rebuilding:', error.message);
      return this.rebuildMetadata(db, encKey);
    }
  }

  isValidMetadata(data) {
    return data &&
      typeof data === 'object' &&
      data.files &&
      typeof data.files === 'object' &&
      Object.values(data.files).every(meta =>
        meta && typeof meta === 'object' && typeof meta.mime === 'string'
      );
  }

  migrateMetadata(data) {
    const version = data.schemaVersion || 1;
    if (version >= this.metadataVersion) return data;

    // Apply version-specific migrations
    Object.values(data.files).forEach(meta => {
      if (!meta.lastModified) meta.lastModified = Date.now();
      if (!meta.lastSize) meta.lastSize = 0;
      if (!meta.lastCompressedSize) meta.lastCompressedSize = 0;
      if (!meta.mime) meta.mime = 'text/plain';
    });

    return { ...data, schemaVersion: this.metadataVersion };
  }

  async rebuildMetadata(db, encKey) {
    const rebuilt = { files: {} };

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

          rebuilt.files[`recovered_${chainId.slice(0, 8)}`] = {
            mime: 'application/octet-stream',
            chainId,
            headVersion: latest.version || 0,
            lastModified: latest.ts || Date.now(),
            lastSize: latest.size || 0,
            lastCompressedSize: 0,
            activeKey: latest.key
          };
        } catch (e) { /* skip corrupted chain */ }
      }

      this.recoveryInfo = {
        timestamp: Date.now(),
        action: `Rebuilt metadata for ${Object.keys(rebuilt.files).length} files`
      };
    } catch (error) {
      this.recoveryInfo = {
        timestamp: Date.now(),
        action: 'Started with empty metadata after rebuild failure'
      };
    }

    return rebuilt;
  }

  async performQuickIntegrityCheck(db, metadata, encKey) {
    const referenced = new Set();
    const toRemove = [];

    for (const [filename, meta] of Object.entries(metadata.files)) {
      let isValid = false;

      // Check chain integrity
      if (meta.chainId) {
        try {
          const chain = await db.get('chains', meta.chainId);
          if (chain?.versions) {
            for (const v of chain.versions) {
              if (v.key && await db.get('files', v.key)) {
                referenced.add(v.key);
                isValid = true;
              }
            }
          }
        } catch (e) { /* chain check failed */ }
      }

      // Check active key
      if (meta.activeKey) {
        try {
          if (await db.get('files', meta.activeKey)) {
            referenced.add(meta.activeKey);
            isValid = true;
          }
        } catch (e) { /* active key check failed */ }
      }

      if (!isValid && (meta.activeKey || meta.headVersion > 0)) {
        toRemove.push(filename);
      }
    }

    // Remove invalid files
    if (toRemove.length > 0) {
      toRemove.forEach(name => delete metadata.files[name]);
      this.recoveryInfo = {
        ...this.recoveryInfo,
        filesRemoved: toRemove
      };
    }

    // Cleanup orphaned files
    await this.cleanupOrphans(db, referenced);
  }

  async cleanupOrphans(db, referenced) {
    try {
      const allKeys = await db.getAllKeys('files');
      const orphaned = allKeys.filter(key =>
        !referenced.has(key) && !key.startsWith('_health_')
      );

      if (orphaned.length > 0) {
        const tx = db.transaction(['files'], 'readwrite');
        await Promise.all(orphaned.map(key =>
          tx.objectStore('files').delete(key).catch(() => { })
        ));
        await tx.done;
      }
    } catch (e) { /* cleanup failed, not critical */ }
  }

  async saveMetadata(db, metadata, encKey, tx = null) {
    const data = {
      files: metadata,
      schemaVersion: this.metadataVersion,
      lastSaved: Date.now()
    };

    if (!this.isValidMetadata(data)) {
      throw new Error('Invalid metadata structure');
    }

    const bytes = encoder.encode(JSON.stringify(data));
    const encrypted = await cryptoUtils.encrypt(bytes, encKey);

    if (tx) {
      await tx.objectStore('meta').put(encrypted, 'index');
    } else {
      await db.put('meta', encrypted, 'index');
    }
  }

  async performFullIntegrityCheck(db, metadata, encKey, keys) {
    const issues = [];
    const referenced = new Set();
    const toRemove = [];

    for (const [filename, meta] of Object.entries(metadata.files)) {
      try {
        if (!meta.chainId) continue;

        const chain = await db.get('chains', meta.chainId);
        if (!chain?.versions) {
          toRemove.push(filename);
          continue;
        }

        let hasValid = false;
        for (const version of chain.versions) {
          if (!version.key) continue;

          try {
            const encrypted = await db.get('files', version.key);
            if (!encrypted) continue;

            const decrypted = await cryptoUtils.decrypt(encrypted, encKey);
            const inflated = await compress.inflate(decrypted);
            const hash = cryptoUtils.hash(inflated);

            if (hash === version.hash && keys.verify(hash, version.sig)) {
              referenced.add(version.key);
              hasValid = true;
            } else {
              issues.push(`Hash/signature mismatch: ${filename} v${version.version}`);
            }
          } catch (e) {
            issues.push(`Verification failed: ${filename} v${version.version}`);
          }
        }

        if (!hasValid) toRemove.push(filename);

      } catch (error) {
        issues.push(`Check failed: ${filename} - ${error.message}`);
        toRemove.push(filename);
      }
    }

    // Remove corrupted files
    toRemove.forEach(name => delete metadata.files[name]);

    // Cleanup orphans
    await this.cleanupOrphans(db, referenced);

    return {
      issues,
      filesRemoved: toRemove,
      orphansRemoved: (await db.getAllKeys('files')).length - referenced.size
    };
  }

  // Recovery helper for corrupted files
  async recoverFileFromPreviousVersion(db, meta, encKey) {
    if (!meta.chainId) return null;

    try {
      const chain = await db.get('chains', meta.chainId);
      if (!chain?.versions || chain.versions.length < 2) return null;

      // Try previous versions in reverse order
      for (let i = chain.versions.length - 2; i >= 0; i--) {
        const version = chain.versions[i];
        if (!version.key) continue;

        try {
          const encrypted = await db.get('files', version.key);
          if (!encrypted) continue;

          const decrypted = await cryptoUtils.decrypt(encrypted, encKey);
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
        } catch (e) { /* try next version */ }
      }
    } catch (error) { /* recovery failed */ }

    return null;
  }

  getRecoveryInfo() {
    return this.recoveryInfo;
  }
}