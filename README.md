# HashFS 🔐

## Encrypted browser storage

[hashfs.js.org](https://hashfs.js.org/)

HashFS is a production-ready Vue 3 composable that provides industry-standard encrypted file storage directly in the browser. It combines content-addressable storage, Ed25519 signatures, and cryptographic hash chains to create a zero-trust file vault with complete privacy - no servers, no tracking, no data leaks.

## ✨ Core Features

- 🔒 **Zero-leak privacy** - Everything encrypted client-side, nothing leaves your browser
- 🔗 **Hash chain integrity** - Cryptographic verification of entire file history
- 🖋️ **Ed25519 signatures** - Tamper-proof authenticity for every version
- 📦 **Content addressing** - SHA-256 deduplication with automatic compression
- ⏱️ **Version control** - Immutable history with configurable retention and undo/redo
- ⚡ **Offline-first** - Works completely offline using IndexedDB
- 🎨 **Vue 3 reactive** - Seamless two-way binding with auto-save
- 🛡️ **Zero dependencies** - Self-contained security, no external services

## 🔐 Security Architecture

### Cryptographic Hash Chains

Each file maintains an immutable chain where every version references the previous:

```
Genesis → Hash(v1) → Hash(v2) → Hash(v3) → Current
   ↓         ↓         ↓         ↓
 Sign(v1)  Sign(v2)  Sign(v3)  Sign(current)
```

This creates an unforgeable history where any tampering breaks the entire chain.

### Key Derivation Pipeline

```
Passphrase → PBKDF2(120k iter) → 64-byte Master Key
                                       ├─ Signing Key (32b) → Ed25519
                                       ├─ Encrypt Key (32b) → AES-256-GCM
                                       └─ Vault ID (16b) → Unique namespace
```

### Storage Flow

```
Content → SHA-256 → Ed25519 Sign → Chain Link → Deflate → AES-GCM → IndexedDB
```

## 🚀 Quick Start

### Installation

```bash
npm install hashfs
```

---

## 🧩 Usage with `useHashFS()` and `useFile()`

The new API introduces a **dual-composable design**:

- `useHashFS(passphrase)` - Manages the secure vault and global file index
- `useFile(vault, name, mime)` - Binds to a specific file for easy reactive read/write

This allows you to directly work with a file as a reactive resource, while still retaining access to full vault management.

---

### Example 1: Upload and read back a **text file**

```vue
<script setup>
	import { ref } from "vue";
	import { useHashFS } from "hashfs";

	const passphrase = ref("correct horse battery staple");

	// Unlock the vault
	const vault = useHashFS(passphrase.value);

	// Create or open a text file
	const notes = vault.useFile(vault, "notes.txt", "text/plain");

	// Reactive text content
	notes.text.value = "Hello, secure world!";

	// Persist change
	await notes.save();

	// Later, read it back
	console.log(notes.text.value); // "Hello, secure world!"
</script>
```

---

### Example 2: Upload and read back a **binary file (image)**

```vue
<script setup>
	import { ref } from "vue";
	import { useHashFS } from "hashfs";

	const passphrase = ref("my-photo-vault");

	// Unlock vault
	const vault = useHashFS(passphrase.value);

	// Work with an image file
	const avatar = vault.useFile("avatar.png");

	// Import from an `<input type="file">`
	const handleFile = async (event) => {
		const file = event.target.files[0];
		await avatar.import(file); // Encrypted & stored
	};

	// Export and display as object URL
	const showImage = async () => {
		const blob = await avatar.export();
		const url = URL.createObjectURL(blob);
		document.querySelector("#preview").src = url;
	};
</script>

<template>
	<input type="file" accept="image/*" @change="handleFile" />
	<button @click="showImage">Show Stored Image</button>
	<img id="preview" />
</template>
```

---

## 📚 API Overview

### `useHashFS(passphrase)`

```js
const vault = useHashFS(passphrase);

// State
vault.auth; // Ref<boolean> - Vault unlocked status
vault.loading; // Ref<boolean> - Operation in progress
vault.files; // ComputedRef<FileInfo[]> - File index

// Operations
await vault.exportAll(); // Export entire vault
await vault.importFile(); // Import a file object
await vault.deleteFile(); // Delete a file

vault.useFile(); // The reactive file reference
```

---

### `useFile(name, defaultContent)`

```js
const file = useFile("document.md", "# Hello");

// Reactive bindings
file.text; // Ref<string> - Auto-decoded text content
file.bytes; // Ref<Uint8Array> - Raw binary content
file.mime; // Ref<string> - MIME type
file.isDirty; // Computed<boolean> - Unsaved changes
file.versions; // Ref<number> - Number of versions

// Methods
await file.save(); // Save current state
await file.import(blob); // Import from Blob/File
await file.export(); // Export as Blob
await file.rename("new.md");
await file.delete();
```

---

## 📦 File Metadata

Each entry in `vault.files` contains:

```ts
{
  name: "document.md",     // File name
  mime: "text/markdown",   // MIME type
  versions: 3,             // Number of versions
  size: 2048,              // Original content size
  compressedSize: 1024,    // Storage size
  modified: 1703123456789, // Last modified timestamp
  active: true             // Currently selected
}
```

## 🔗 Hash Chain Verification

### Chain Structure

```javascript
// Each version forms a link in the cryptographic chain
{
  version: 3,                    // Sequential version number
  hash: "abc123...",            // SHA-256 of content
  sig: "def456...",             // Ed25519 signature of hash
  key: "sk_789...",             // Storage key (hash:sig)
  size: 1024,                   // Original content size
  ts: 1703123456789,           // Creation timestamp
  parentHash: "xyz999..."       // Links to previous version
}
```

### Verification Process

```javascript
// HashFS automatically verifies:
1. Content matches hash (integrity)
2. Signature is valid (authenticity)
3. Chain links are unbroken (history)
4. No versions are missing (completeness)

// Any failure throws an error and prevents access
```

## 🛡️ Security Guarantees

### Zero-Leak Privacy

- **No network requests** - Everything stays in your browser
- **No telemetry** - Zero tracking or analytics
- **No plaintext** - All content encrypted at rest
- **No metadata leaks** - Even file names are encrypted
- **No key escrow** - Only your passphrase can decrypt

### Cryptographic Assurance

- **AES-256-GCM** - Industry-standard authenticated encryption
- **Ed25519** - State-of-the-art elliptic curve signatures
- **SHA-256** - Collision-resistant content addressing
- **PBKDF2** - 120,000 iterations against rainbow tables
- **Random IVs** - Fresh entropy for every encryption

### Integrity Protection

- **Hash chains** - Detect any tampering with version history
- **Content addressing** - Impossible to modify without changing hash
- **Cryptographic signatures** - Prove authenticity of every change
- **Atomic transactions** - Prevent corruption from interrupted operations

## 🔧 Security Considerations

### Threat Model

**HashFS protects against:**

- ✅ Data breaches (encrypted at rest)
- ✅ Content tampering (hash chain verification)
- ✅ History rewriting (cryptographic signatures)
- ✅ Unauthorized access (strong key derivation)
- ✅ Man-in-the-middle (client-side only)

### Limitations

- ❌ **Passphrase attacks** - Use strong, unique passphrases (20+ chars)
- ❌ **Browser vulnerabilities** - Keep browser updated
- ❌ **Physical device access** - Browser may cache decrypted data
- ❌ **Side-channel attacks** - JavaScript crypto has limitations

### Best Practices

1. **Strong Passphrases** - Use unique 20+ character passphrases
2. **HTTPS Required** - WebCrypto API needs secure context
3. **Regular Backups** - Export data with `exportAll()` periodically
4. **Browser Security** - Keep browser and extensions updated
5. **Private Mode** - Consider for highly sensitive data
6. **Physical Security** - Lock your device when not in use

## 🏗️ Technical Architecture

### Storage Layer

```
Browser Environment
├─ IndexedDB
│  ├─ files/     (encrypted content blobs)
│  ├─ meta/      (encrypted file metadata)
│  └─ chains/    (encrypted version chains)
└─ Memory
   ├─ Vue reactive state
   ├─ LRU chain cache
   └─ Derived cryptographic keys
```

### Cryptographic Stack

```
@noble/curves   (Ed25519 signatures)
@noble/hashes   (SHA-256, PBKDF2)
@noble/ciphers   (AES-256-GCM)
fflate          (Deflate compression)
```

### Vue Integration

```
Composition API
├─ Reactive state management
├─ Computed property bindings
├─ Auto-save with debouncing
└─ Lifecycle cleanup
```

## 🚧 Development

```bash
git clone https://github.com/yourusername/hashfs
cd hashfs
pnpm install
pnpm run dev
pnpm run lib
pnpm run build
```

---

## 📄 License

This project is licensed under the MIT License.

## 🙏 Acknowledgments

Built on audited cryptographic primitives:

- **@noble/crypto** - Secure, audited cryptography
- **Vue.js** - Reactive framework foundation
- **fflate** - Fast, reliable compression
- **IndexedDB** - Browser-native storage

---

**🔒 Security Notice**: HashFS provides strong cryptographic protection, but no system is perfect. Always follow security best practices and consider your specific threat model when storing sensitive data. The zero-leak design means lost passphrases cannot be recovered - keep secure backups.
