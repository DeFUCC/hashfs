import { deflate, inflate, zipSync, unzipSync } from 'fflate';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

// Core crypto utilities
export const cryptoUtils = {
  async deriveKeys(pwd) {
    const pwdBytes = encoder.encode(String(pwd || '').normalize('NFC').trim());
    if (pwdBytes.length < 8) throw new Error('Password too short');

    const salt = encoder.encode('hashfs-v5-2025');
    const masterKey = pbkdf2(sha256, pwdBytes, salt, { c: 120000, dkLen: 64 });

    const sigKey = masterKey.slice(0, 32);
    const encKey = masterKey.slice(32, 64);
    const pubKey = ed25519.getPublicKey(sigKey);

    const dbName = bytesToHex(sha256(pubKey).slice(0, 16)) + '-hashfs-v5';

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

  async encrypt(bytes, keyBytes) {
    const iv = randomBytes(12);
    const aes = gcm(keyBytes, iv);
    const ciphertext = aes.encrypt(bytes);
    return { iv, data: ciphertext };
  },

  async decrypt(payload, keyBytes) {
    const aes = gcm(keyBytes, payload.iv);
    return new Uint8Array(aes.decrypt(payload.data));
  }
};

// Compression utilities
export const compress = {
  deflate: (bytes) => new Promise((resolve, reject) =>
    deflate(bytes, (err, result) => err ? reject(err) : resolve(result))),
  inflate: (bytes) => new Promise((resolve, reject) =>
    inflate(bytes, (err, result) => err ? reject(err) : resolve(result)))
};

// ZIP helpers (sync) exposed for worker usage
compress.zip = (entries, opts) => zipSync(entries, opts);
compress.unzip = (u8) => unzipSync(u8);

// Chain management with improved caching
export function createChainManager(db, encKey, maxCache = 20) {
  const cache = new Map();

  async function getChain(chainId) {
    if (cache.has(chainId)) {
      const cached = cache.get(chainId);
      cache.delete(chainId);
      cache.set(chainId, cached);
      return cached;
    }

    try {
      const encrypted = await db.get('chains', chainId);
      if (!encrypted) return { versions: [], pruned: { count: 0, oldestKept: 0 } };

      const decrypted = await cryptoUtils.decrypt(encrypted, encKey);
      const chain = JSON.parse(decoder.decode(decrypted));

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

    if (cache.size >= maxCache) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(chainId, chain);
  }

  async function addVersion(chainId, version) {
    const chain = await getChain(chainId);
    chain.versions.push(version);

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

    if (toDelete.length > 0) {
      const tx = db.transaction(['files'], 'readwrite');
      for (const key of toDelete) {
        try { await tx.objectStore('files').delete(key); }
        catch (e) { console.warn('Failed to delete orphaned content:', key); }
      }
      await tx.done;
    }

    return chain;
  }

  return { getChain, saveChain, addVersion };
}