import { deflate, inflate, zipSync, unzipSync } from 'fflate';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { scrypt, scryptAsync } from '@noble/hashes/scrypt.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { blake3 } from '@noble/hashes/blake3';
import { hkdf } from '@noble/hashes/hkdf';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

// Core crypto utilities
export const cryptoUtils = {
  async deriveKeys(pwd) {
    const pwdBytes = encoder.encode(String(pwd || '').normalize('NFC').trim());
    if (pwdBytes.length < 8) throw new Error('Password too short');

    const salt = encoder.encode('hashfs-v6-2025');

    const N = 1 << 17; // work factor (use 2^17 by default)
    const r = 8;
    const p = 1;
    const dkLen = 32;

    const maxmem = N * r * p * 128 + (128 * r * p);
    const masterKey = scrypt(pwdBytes, salt, { N, r, p, dkLen, maxmem });

    const sigKey = hkdf(sha256, masterKey, salt, encoder.encode('signing'), 32);
    const encKey = hkdf(sha256, masterKey, salt, encoder.encode('encryption'), 32);
    const pubKey = ed25519.getPublicKey(sigKey);

    const dbName = bytesToHex(blake3(pubKey).slice(0, 16)) + '-hashfs-v6';

    return {
      sigKey, pubKey, encKey, dbName,
      sign: (hash) => bytesToHex(ed25519.sign(hexToBytes(hash), sigKey)),
      verify: (hash, sig) => {
        try { return ed25519.verify(hexToBytes(sig), hexToBytes(hash), pubKey); }
        catch { return false; }
      }
    };
  },

  hash: (bytes) => bytesToHex(blake3(bytes)),
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
export function createChainManager(db, encKey, maxCache = 20, { sign, verify } = {}) {
  const cache = new Map();
  // Expect sign and verify functions (from derived keys)
  const signer = sign;
  const verifier = verify;

  async function getChain(chainId) {
    if (cache.has(chainId)) {
      const cached = cache.get(chainId);
      cache.delete(chainId);
      cache.set(chainId, cached);
      return cached;
    }

    try {
      const stored = await db.get('chains', chainId);
      if (!stored) return { versions: [], pruned: { count: 0, oldestKept: 0 } };

      // Decrypt the stored chain data and decompress
      const decrypted = await cryptoUtils.decrypt(stored, encKey);
      const inflated = await compress.inflate(decrypted);

      // Verify chain signature (signature is required)
      if (!stored.sig) throw new Error('Missing chain signature');
      const hash = cryptoUtils.hash(decrypted); // signature is over compressed bytes
      if (!verifier || !verifier(hash, stored.sig)) throw new Error('Chain signature verification failed');

      const chain = JSON.parse(decoder.decode(inflated));

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
    // Serialize and compress the chain data
    const bytes = encoder.encode(JSON.stringify(chain));
    const compressed = await compress.deflate(bytes);

    // Sign the compressed data (signature over compressed bytes)
    const hash = cryptoUtils.hash(compressed);
    if (!signer) throw new Error('No signer available for chain signing');
    const sig = signer(hash);

    // Encrypt the compressed data
    const encrypted = await cryptoUtils.encrypt(compressed, encKey);
    // Attach signature so it survives in storage alongside iv/data
    encrypted.sig = sig;

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