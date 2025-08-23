import { ref, computed, onBeforeUnmount } from 'vue';
import { openDB } from 'idb';
import { deflate, inflate } from 'fflate';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

const encoder = new TextEncoder()
const decoder = new TextDecoder()


export function useHashFS(passphrase) {
  const auth = ref(false);
  const keys = ref(null);
  const db = ref(null);
  const loading = ref(false);

  const filesMeta = ref({});
  const currentFile = ref('');
  const currentMime = ref('text/markdown');
  const contentBytes = ref(new Uint8Array());
  const dirty = ref(false);

  const filesList = computed(() => {
    return Object.entries(filesMeta.value)
      .map(([name, meta]) => {
        // Use head for latest
        let latest = {};
        if (meta && meta.head && Array.isArray(meta.versions)) {
          latest = meta.versions.find(v => v.v === meta.head.v) || {};
        } else if (Array.isArray(meta?.versions) && meta.versions.length) {
          latest = meta.versions[meta.versions.length - 1];
        }
        return {
          name,
          mime: meta.mime || 'text/markdown',
          versions: meta.head?.v || 0,
          size: latest?.sizes?.original || 0,
          modified: latest?.ts || 0,
          active: currentFile.value === name,
          hash: (meta.head?.hash) || latest.hash || null
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  const contentText = computed({
    get() {
      try {
        return decoder.decode(contentBytes.value || new Uint8Array());
      } catch { return ''; }
    },
    set(text) {
      contentBytes.value = encoder.encode(text || '');
      dirty.value = true;
      scheduleAutoSave();
    }
  });

  // Auto-save timer
  let saveTimer = null;
  function scheduleAutoSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveFile(), 800);
  }

  async function login() {
    if (!String(passphrase || '').trim()) return;
    loading.value = true;
    try {
      keys.value = await crypto.deriveKeys(passphrase);

      // Use versioned, non-destructive upgrades with lifecycle handlers
      db.value = await openDB(keys.value.dbName, 2, {
        async upgrade(dbx, oldVersion, newVersion, tx) {
          console.log('Upgrading DB from version', oldVersion, 'to', newVersion);

          // v1: ensure stores exist; migrate legacy 'metadata' -> 'meta' if present
          if (oldVersion < 1) {
            if (!dbx.objectStoreNames.contains('files')) {
              console.log('Creating files store');
              dbx.createObjectStore('files');
            }
            if (!dbx.objectStoreNames.contains('meta')) {
              console.log('Creating meta store');
              dbx.createObjectStore('meta');
            }
          }

          // v2: optional migration from legacy 'metadata' store name
          if (dbx.objectStoreNames.contains('metadata')) {
            try {
              if (!dbx.objectStoreNames.contains('meta')) {
                dbx.createObjectStore('meta');
              }
              const legacy = tx.objectStore('metadata');
              const modern = tx.objectStore('meta');
              const legacyIndex = await legacy.get('index');
              if (legacyIndex) {
                await modern.put(legacyIndex, 'index');
              }
              dbx.deleteObjectStore('metadata');
              console.log('Migrated legacy metadata -> meta');
            } catch (e) {
              console.warn('Metadata migration issue:', e);
            }
          }
        },
        blocked(currentVersion, blockedVersion, event) {
          console.warn('DB open blocked by another tab/session', { currentVersion, blockedVersion });
          console.log('Database upgrade is blocked by another open tab. Please close other tabs using this app.');
        },
        blocking(currentVersion, blockedVersion, event) {
          console.warn('This tab is blocking a newer version from opening elsewhere', { currentVersion, blockedVersion });
          console.log('A newer version of this app is trying to open the database. This tab will close its connection soon.');
        },
        terminated() {
          console.error('Database connection unexpectedly terminated');
          console.log('Database connection was terminated (likely due to system conditions). Reload the page.');
        }
      });

      console.log('DB opened successfully, stores:', Array.from(db.value.objectStoreNames));

      // React to external upgrades: close and ask user to reload
      try {
        db.value.addEventListener?.('versionchange', () => {
          try { db.value.close(); } catch { }
          console.log('Database was upgraded in another tab. Please reload this page.');
        });
      } catch { }

      // Load metadata
      try {
        const encrypted = await db.value.get('meta', 'index');
        if (encrypted) {
          const jsonBytes = await crypto.decryptToBytes(encrypted, keys.value.encKey);
          filesMeta.value = JSON.parse(decoder.decode(jsonBytes)) || {};
        }
      } catch (e) {
        console.warn('Could not load metadata:', e);
        filesMeta.value = {};
      }

      // Migrate metadata in-memory to add version numbers and head pointer
      let migrated = false;
      for (const [name, meta] of Object.entries(filesMeta.value)) {
        meta.versions = Array.isArray(meta.versions) ? meta.versions : [];
        // Assign version numbers if missing
        if (meta.versions.length && !('v' in meta.versions[0])) {
          // Sort by timestamp ascending as best-effort ordering
          meta.versions.sort((a, b) => (a.ts || 0) - (b.ts || 0));
          let v = 1;
          for (const entry of meta.versions) {
            entry.v = v++;
          }
          migrated = true;
        }
        // Ensure versions sorted by v ascending
        if (meta.versions.length) {
          meta.versions.sort((a, b) => (a.v || 0) - (b.v || 0));
        }
        // Ensure head and nextVersion
        const last = meta.versions.length ? meta.versions[meta.versions.length - 1] : null;
        if (!meta.head && last) {
          meta.head = { v: last.v, hash: last.hash, key: last.key };
          migrated = true;
        }
        if (typeof meta.nextVersion !== 'number') {
          meta.nextVersion = last ? (last.v + 1) : 1;
          migrated = true;
        }
      }
      if (migrated) await saveMetadata();

      // Cleanup pass: prune orphan file blobs, repair meta inconsistencies, cap versions
      try {
        const changed = await cleanupConsistency();
        if (changed) await saveMetadata();
      } catch (e) {
        console.warn('Cleanup pass failed:', e);
      }

      auth.value = true;
    } catch (e) {
      alert('Authentication failed: ' + e.message);
    } finally {
      loading.value = false;
    }
  }

  async function saveMetadata() {
    const jsonBytes = encoder.encode(JSON.stringify(filesMeta.value || {}));
    const encrypted = await crypto.encryptBytes(jsonBytes, keys.value.encKey);
    await db.value.put('meta', encrypted, 'index');
  }

  // Cleanup: ensure consistency between 'files' blobs and 'meta' references
  // - Delete orphan blobs not referenced by any meta entry
  // - Drop meta versions whose blobs are missing
  // - Recompute head and nextVersion
  // Returns: true if metadata was changed
  async function cleanupConsistency() {
    let changed = false;

    // Build set of referenced keys from metadata
    const referenced = new Set();
    for (const meta of Object.values(filesMeta.value)) {
      for (const v of (meta?.versions || [])) {
        if (v?.key) referenced.add(v.key);
      }
    }

    // Fetch all existing blob keys
    let allKeys = [];
    try {
      allKeys = await db.value.getAllKeys('files');
    } catch (e) {
      console.warn('Unable to list file keys for cleanup:', e);
    }
    const present = new Set(allKeys);

    // Delete orphan blobs in a single transaction
    try {
      const tx = db.value.transaction(['files'], 'readwrite');
      const filesStore = tx.objectStore('files');
      for (const key of allKeys) {
        if (!referenced.has(key)) {
          try { await filesStore.delete(key); } catch { }
        }
      }
      await tx.done;
    } catch (e) {
      console.warn('Failed to delete orphan blobs:', e);
    }

    // Repair metadata: remove versions pointing to missing blobs
    for (const [name, meta] of Object.entries(filesMeta.value)) {
      const before = meta.versions?.length || 0;
      meta.versions = (meta.versions || []).filter(v => present.has(v.key));
      // Maintain ordering by version
      meta.versions.sort((a, b) => (a.v || 0) - (b.v || 0));
      const after = meta.versions.length;
      if (after !== before) changed = true;

      // Recompute head and nextVersion
      const last = after ? meta.versions[after - 1] : null;
      if (last) {
        if (!meta.head || meta.head.v !== last.v || meta.head.hash !== last.hash || meta.head.key !== last.key) {
          meta.head = { v: last.v, hash: last.hash, key: last.key };
          changed = true;
        }
        const expectedNext = (last.v || 0) + 1;
        if (meta.nextVersion !== expectedNext) {
          meta.nextVersion = expectedNext;
          changed = true;
        }
      } else {
        if (meta.head) { meta.head = null; changed = true; }
        if (meta.nextVersion !== 1) { meta.nextVersion = 1; changed = true; }
      }
      if (!meta.mime) meta.mime = 'text/markdown';
    }

    return changed;
  }

  async function loadFile(name) {
    if (dirty.value && currentFile.value) await saveFile();

    currentFile.value = name;
    if (!filesMeta.value[name]) {
      filesMeta.value[name] = { name, mime: 'text/markdown', versions: [], head: null, nextVersion: 1 };
    }

    const meta = filesMeta.value[name];
    currentMime.value = meta.mime || 'text/markdown';

    // Determine HEAD version reliably
    let latest = null;
    if (meta.head && typeof meta.head.v === 'number') {
      latest = (meta.versions || []).find(v => v.v === meta.head.v) || null;
    }
    if (!latest && (meta.versions || []).length) {
      // Fallback to highest v
      latest = [...meta.versions].sort((a, b) => (a.v || 0) - (b.v || 0)).slice(-1)[0];
      // Update head if missing
      meta.head = { v: latest.v, hash: latest.hash, key: latest.key };
      await saveMetadata();
    }
    if (!latest) {
      // New file - seed with example
      const example = `## Welcome to your encrypted file vault!\n\nYou can edit this file, create new ones or import from your device.`;
      contentBytes.value = encoder.encode(example);
      dirty.value = true;
      return;
    }

    loading.value = true;
    try {
      const encrypted = await db.value.get('files', latest.key);
      if (encrypted) {
        const compressed = await crypto.decryptToBytes(encrypted, keys.value.encKey);
        const inflated = await compress.inflate(compressed);
        // Verify integrity (hash) and authenticity (signature)
        const computedHash = await crypto.hashBytes(inflated);
        const hashMatches = computedHash === latest.hash;
        const sigValid = keys.value.verify(latest.hash, latest.sig);
        if (!hashMatches || !sigValid) {
          console.error('Verification failed', { hashMatches, sigValid });
          contentBytes.value = new Uint8Array();
          throw new Error('File verification failed. Content may be corrupted or tampered.');
        }
        contentBytes.value = inflated;
        dirty.value = false;
      }
    } catch (e) {
      console.error('Load error:', e);
      contentBytes.value = new Uint8Array();
      try { if (e && e.message) alert(e.message); } catch { }
    } finally {
      loading.value = false;
    }
  }

  async function saveFile() {
    if (!currentFile.value) return;

    const name = currentFile.value;
    const bytes = contentBytes.value || new Uint8Array();

    // Content-addressable hash
    const hash = await crypto.hashBytes(bytes);

    // Ensure file meta exists
    if (!filesMeta.value[name]) {
      filesMeta.value[name] = { name, mime: currentMime.value, versions: [], head: null, nextVersion: 1 };
    }
    const meta = filesMeta.value[name];

    // If content unchanged (same HEAD hash), do not create a new version
    if (meta.head?.hash === hash) {
      // Allow MIME update without version bump
      if (meta.mime !== currentMime.value) {
        meta.mime = currentMime.value;
        await saveMetadata();
      }
      dirty.value = false;
      return;
    }

    const sig = keys.value.sign(hash);
    const key = `${hash}:${sig}`;

    // Compress, encrypt (outside transaction)
    const compressed = await compress.deflate(bytes);
    const encrypted = await crypto.encryptBytes(compressed, keys.value.encKey);

    // Update metadata (in-memory) BEFORE starting transaction
    meta.mime = currentMime.value;
    const vnum = typeof meta.nextVersion === 'number' ? meta.nextVersion : ((meta.versions?.slice(-1)[0]?.v || 0) + 1);
    meta.versions.push({
      v: vnum,
      hash,
      sig,
      key,
      sizes: {
        original: bytes.length,
        compressed: compressed.length,
        encrypted: (encrypted.iv?.length || 0) + (encrypted.data?.length || 0)
      },
      ts: Date.now()
    });
    // Maintain ordering by version
    meta.versions.sort((a, b) => (a.v || 0) - (b.v || 0));
    // Update head and bump nextVersion
    meta.head = { v: vnum, hash, key };
    meta.nextVersion = vnum + 1;

    // Keep last 10 versions (oldest first) - decide deletions now
    const toDelete = [];
    while (meta.versions.length > 10) {
      const old = meta.versions.shift();
      toDelete.push(old.key);
    }

    // Prepare encrypted metadata payload before transaction
    const jsonBytes = encoder.encode(JSON.stringify(filesMeta.value || {}));
    const metaEncrypted = await crypto.encryptBytes(jsonBytes, keys.value.encKey);

    // Perform atomic write of file blob and metadata in a single transaction
    const tx = db.value.transaction(['files', 'meta'], 'readwrite');
    const filesStore = tx.objectStore('files');
    const metaStore = tx.objectStore('meta');

    await filesStore.put(encrypted, key);
    for (const k of toDelete) {
      try { await filesStore.delete(k); } catch { }
    }
    await metaStore.put(metaEncrypted, 'index');

    await tx.done;
    dirty.value = false;
  }

  function newFile() {
    const name = prompt('File name:')?.trim();
    if (!name || filesMeta.value[name]) {
      if (filesMeta.value[name]) alert('File exists');
      return;
    }
    filesMeta.value[name] = { name, mime: 'text/markdown', versions: [] };
    loadFile(name);
  }

  async function deleteFile(name) {
    if (!confirm(`Delete ${name}?`)) return;
    const meta = filesMeta.value[name];
    // Prepare updated metadata and encrypted payload before transaction
    const keysToDelete = (meta?.versions || []).map(v => v.key);
    delete filesMeta.value[name];
    const jsonBytes = encoder.encode(JSON.stringify(filesMeta.value || {}));
    const metaEncrypted = await crypto.encryptBytes(jsonBytes, keys.value.encKey);

    const tx = db.value.transaction(['files', 'meta'], 'readwrite');
    const filesStore = tx.objectStore('files');
    const metaStore = tx.objectStore('meta');
    for (const k of keysToDelete) {
      try { await filesStore.delete(k); } catch { }
    }
    await metaStore.put(metaEncrypted, 'index');
    await tx.done;
    if (currentFile.value === name) {
      currentFile.value = '';
      contentBytes.value = new Uint8Array();
      dirty.value = false;
    }
  }

  async function importFile(file) {
    if (!file) return;
    currentFile.value = file.name;
    currentMime.value = file.type || 'application/octet-stream';
    contentBytes.value = new Uint8Array(await file.arrayBuffer());
    dirty.value = true;
  }

  function exportFile() {
    if (!currentFile.value) return;
    const blob = new Blob([contentBytes.value], { type: currentMime.value });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url,
      download: currentFile.value
    }).click();
    URL.revokeObjectURL(url);
  }

  // Cleanup
  onBeforeUnmount(() => {
    if (saveTimer) clearTimeout(saveTimer);
  });

  return {
    auth, loading, filesMeta, filesList,
    currentFile, currentMime, contentText, contentBytes, dirty,
    login, loadFile, saveFile, newFile, deleteFile, importFile, exportFile
  };
}


export const crypto = {
  async deriveKeys(pwd) {
    const pwdBytes = encoder.encode(String(pwd || '').normalize('NFC').trim());
    if (pwdBytes.length < 8) throw new Error('Password too short');

    // Use WebCrypto PBKDF2 for key derivation (compatible approach)
    const salt = encoder.encode('idb-vault-v2');
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw', pwdBytes, 'PBKDF2', false, ['deriveBits']
    );
    const derivedBits = await window.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial, 512 // 64 bytes
    );
    const masterKey = new Uint8Array(derivedBits);

    // Derive Ed25519 signing key (32 bytes)
    const sigKey = masterKey.slice(0, 32);
    const pubKey = ed25519.getPublicKey(sigKey);

    // Derive AES encryption key (32 bytes)
    const encKeyMaterial = masterKey.slice(32, 64);
    const encKey = await window.crypto.subtle.importKey(
      'raw', encKeyMaterial, 'AES-GCM', false, ['encrypt', 'decrypt']
    );

    // Database name from public key hash
    const pubKeyHash = new Uint8Array(await window.crypto.subtle.digest('SHA-256', pubKey));

    // Expose a non-extractable-like handle for the signing key and a signer function
    const signKey = Object.freeze({ type: 'private', algorithm: { name: 'Ed25519' }, usages: ['sign'] });
    const sign = (hashHex) => crypto.signHash(hashHex, sigKey);
    const verifyKey = Object.freeze({ type: 'public', algorithm: { name: 'Ed25519' }, usages: ['verify'] });
    const verify = (hashHex, sigHex) => crypto.verifyHash(hashHex, sigHex, pubKey);

    return {
      signKey,
      sign,
      verifyKey,
      verify,
      encKey,
      dbName: bytesToHex(pubKeyHash.slice(0, 16)) // 32 hex chars
    };
  },

  // Content-addressable hash ID using WebCrypto
  async hashBytes(bytes) {
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
  },

  // Ed25519 signature for authenticity
  signHash(hashHex, sigKey) {
    const hashBytes = hexToBytes(hashHex);
    const sig = ed25519.sign(hashBytes, sigKey);
    return bytesToHex(sig);
  },

  // Verify Ed25519 signature
  verifyHash(hashHex, sigHex, pubKey) {
    try {
      const hashBytes = hexToBytes(hashHex);
      const sigBytes = hexToBytes(sigHex);
      return ed25519.verify(sigBytes, hashBytes, pubKey);
    } catch { return false; }
  },

  async encryptBytes(bytes, key) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return {
      iv,
      data: new Uint8Array(encrypted)
    };
  },

  async decryptToBytes(payload, key) {
    const iv = new Uint8Array(payload.iv);
    const data = new Uint8Array(payload.data);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );
    return new Uint8Array(decrypted);
  }
};

export const compress = {
  async deflate(bytes) {
    return new Promise((resolve, reject) =>
      deflate(bytes, (err, result) => err ? reject(err) : resolve(result))
    );
  },

  async inflate(bytes) {
    return new Promise((resolve, reject) =>
      inflate(bytes, (err, result) => err ? reject(err) : resolve(result))
    );
  }
};