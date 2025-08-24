import { deflate, inflate } from 'fflate';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { randomBytes } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Core crypto utilities
export const cryptoUtils = {
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

    const salt = encoder.encode('hashfs-v4-2025');
    const masterKey = pbkdf2(sha256, pwdBytes, salt, { c: 120000, dkLen: 64 });

    const sigKey = masterKey.slice(0, 32);
    const encKeyBytes = masterKey.slice(32, 64);
    const pubKey = ed25519.getPublicKey(sigKey);

    const encKey = await window.crypto.subtle.importKey(
      'raw', encKeyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']
    );

    const dbName = bytesToHex(sha256(pubKey).slice(0, 16)) + '-hashfs-v4';

    return {
      sigKey, pubKey, encKey, dbName,
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

  async encrypt(bytes, key) {
    if (!this.isSecureContext) throw new Error('Encryption requires secure context');
    const iv = randomBytes(12);
    const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { iv, data: new Uint8Array(encrypted) };
  },

  async decrypt(payload, key) {
    if (!this.isSecureContext) throw new Error('Decryption requires secure context');
    return new Uint8Array(await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.iv }, key, payload.data
    ));
  }
};

// Compression utilities
export const compress = {
  deflate: (bytes) => new Promise((resolve, reject) =>
    deflate(bytes, (err, result) => err ? reject(err) : resolve(result))),
  inflate: (bytes) => new Promise((resolve, reject) =>
    inflate(bytes, (err, result) => err ? reject(err) : resolve(result)))
};

// Chain management with LRU cache
export function createChainManager(db, encKey, maxCache = 10) {
  const cache = new Map();

  async function getChain(chainId) {
    // Check cache first
    if (cache.has(chainId)) {
      const cached = cache.get(chainId);
      cache.delete(chainId);
      cache.set(chainId, cached); // Move to end (LRU)
      return cached;
    }

    // Load from database
    try {
      const encrypted = await db.get('chains', chainId);
      if (!encrypted) return { versions: [], pruned: { count: 0, oldestKept: 0 } };

      const decrypted = await cryptoUtils.decrypt(encrypted, encKey);
      const chain = JSON.parse(decoder.decode(decrypted));

      // Cache with LRU eviction
      if (cache.size >= maxCache) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      cache.set(chainId, chain);
      return chain;

    } catch (error) {
      console.warn('Chain load failed:', chainId, error);
      return { versions: [], pruned: { count: 0, oldestKept: 0 } };
    }
  }

  async function saveChain(chainId, chain) {
    const bytes = encoder.encode(JSON.stringify(chain));
    const encrypted = await cryptoUtils.encrypt(bytes, encKey);
    await db.put('chains', encrypted, chainId);

    // Update cache
    if (cache.size >= maxCache) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(chainId, chain);
  }

  async function addVersion(chainId, version) {
    const chain = await getChain(chainId);
    chain.versions.push(version);

    // Prune if needed (keep last 15 versions)
    const toDelete = [];
    while (chain.versions.length > 15) {
      const old = chain.versions.shift();
      toDelete.push(old.key);
      chain.pruned.count++;
    }

    if (chain.versions.length > 0) {
      chain.pruned.oldestKept = chain.versions[0].version;
    }

    await saveChain(chainId, chain);

    // Clean up orphaned content
    if (toDelete.length > 0) {
      const tx = db.transaction(['files'], 'readwrite');
      const store = tx.objectStore('files');

      for (const key of toDelete) {
        try {
          await store.delete(key);
        } catch (e) {
          console.warn('Failed to delete orphaned content:', key);
        }
      }
      await tx.done;
    }

    return chain;
  }

  async function verifyChain(chainId, keys) {
    const chain = await getChain(chainId);
    return chain.versions.every(version =>
      keys.verify(version.hash, version.sig)
    );
  }

  return { getChain, saveChain, addVersion, verifyChain };
}