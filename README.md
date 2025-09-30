# HashFS 🔐

## Encrypted browser storage

[hashfs.js.org](https://hashfs.js.org/)

HashFS is a production-ready Vue 3 composable that provides industry-standard encrypted file storage directly in the browser. It combines content-addressable storage, Ed25519 signatures, and cryptographic hash chains to create a zero-trust file vault with complete privacy - no servers, no tracking, no data leaks.

## ✨ Core Features

- 🔒 **Zero-leak privacy** - Everything encrypted client-side, nothing leaves your browser
- 🔗 **Hash chain integrity** - Cryptographic verification of entire file history
- 🖋️ **Ed25519 signatures** - Tamper-proof authenticity for every version
- 📦 **Content addressing** - BLAKE3 deduplication with automatic compression
- ⏱️ **Version control** - Immutable history with configurable retention and undo/redo
- ⚡ **Offline-first** - Works completely offline using IndexedDB
- 🎨 **Vue 3 reactive** - Seamless two-way binding with auto-save
- 🛡️ **Zero dependencies** - Self-contained security, no external services

## Working example

```html
<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>#FS test</title>
		<script type="importmap">
			{ "imports": { "vue": "https://esm.sh/vue" } }
		</script>
	</head>

	<body>
		<div id="app" style="display:flex; flex-direction: column; gap: 1em;">
			<input type="text" id="input" style="width:80svw;" />
			<textarea style="width:80svw;height:80svh" id="text" disabled></textarea>
		</div>
		<script type="module">
			import { ref, watch } from "vue";
			import { useHashFS, useFile } from "./lib/index.js";

			const md = useFile("readme.md", "## Initial content");

			const input = document.getElementById("input");

			input.addEventListener("change", (e) => {
				const fs = useHashFS(e?.target?.value);
			});

			const textarea = document.getElementById("text");

			watch(
				md.loading,
				(l) => {
					if (!l) {
						textarea.disabled = false;
					}
				},
				{ immediate: true }
			);

			watch(
				md.text,
				(t) => {
					textarea.innerText = t;
				},
				{ immediate: true }
			);

			textarea.addEventListener("change", (e) => {
				md.text.value = e?.target?.value;
				md.save();
			});
		</script>
	</body>
</html>
```

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
Passphrase → scrypt(N=2^17, r=8, p=1) → 32-byte Master Key
                                       ├─ HKDF-SHA256(..., "signing") → Signing Key (32b) → Ed25519
                                       ├─ HKDF-SHA256(..., "encryption") → Encrypt Key (32b) → AES-256-GCM
                                       └─ BLAKE3(pubKey)[0..15] → Vault namespace (dbName)
```

### Storage Flow

```
Content → BLAKE3 (content-address) → Chain link metadata → JSON chain → DEFLATE (fflate) → BLAKE3(compressed) → Ed25519 sign(compressed hash) → AES-GCM encrypt(compressed bytes) → IndexedDB (payload + signature)
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
	const notes = vault.useFile(vault, "notes.md", { mime: "text/markdown" });

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
vault.files; // Ref<FileInfo[]> - File index
vault.stats; // ComputedRef - aggregate stats (sizes, compression ratio, vault metrics)

// Operations
await vault.importAll(fileList, onProgress); // Bulk import File[] from an <input>
await vault.exportZip(onProgress); // Export vault contents as a zip (Uint8Array)
await vault.importZip(arrayBuffer, onProgress); // Import vault contents from zip
await vault.downloadVault(filename, onProgress); // Trigger browser download of vault zip
await vault.getVaultSizes(); // Get detailed vault size information
vault.close(); // Close and terminate internal worker/session

// Note: `useFile` is provided as a separate composable (re-exported by the package). Use `useFile(name, defaultContent)` to bind to a single file resource.
```

---

## 📊 Vault Size Metrics

HashFS provides three distinct size measurements to help you understand your storage usage:

### Size Types

- **Original Size** - Sum of current file contents (what you'd see if you downloaded all files)
- **Compressed Size** - Size of vault when exported as ZIP (latest versions only, no version history)
- **Vault Size** - Total IndexedDB storage including all versions, chains, and metadata

### Example Display

```
Files (8)
Original: 2.9 MB           ← Current file contents
Compressed: 803.0 KB       ← ZIP export size (72.5% smaller!)
Vault size: 10.9 MB        ← Full IndexedDB storage
Saved: 72.5%
```

### Compression Behavior

**Text Files** (Markdown, HTML, JSON):
- Typically compress 50-70% (amazing ratios!)

**Binary Files** (Images, PDFs, Videos):
- Already compressed formats may show modest savings or slight growth
- Growth can occur due to ZIP compression headers on small files
- Overall vault compression usually more than compensates

### API Usage

```js
const vault = useHashFS(passphrase);

// Get detailed size information
const sizes = await vault.getVaultSizes();
// Returns: { vaultSize: number, vaultCompressedSize: number }

// Access via stats computed property
console.log(vault.stats.value);
// Contains: original size, compressed size, vault size, compression ratio
```

---

### `useFile(name, defaultContent)`

```js
const file = useFile("document.md", "# Hello");

// Instance shape (returns a singleton per filename)
file.loading; // Ref<boolean> - load/save operation in progress
file.filename; // string - the file name (read-only on instance)
file.mime; // Ref<string> - MIME type
file.text; // ComputedRef<string> - UTF-8 text view (getter decodes bytes, setter encodes & marks dirty)
file.bytes; // Ref<Uint8Array> - raw binary content
file.dirty; // Ref<boolean> - unsaved changes
file.currentVersion; // Ref<number> - currently loaded version number
file.availableVersions; // Ref<{min:number,max:number}> - range of available versions
file.canUndo; // ComputedRef<boolean> - whether undo is possible
file.canRedo; // ComputedRef<boolean> - whether redo is possible

// Methods (all async when performing IO)
await file.load((version = null)); // Load latest or specified version
await file.save(); // Persist current bytes to the vault
await file.import(fileBlob); // Import from a Blob/File (reads bytes, sets mime and saves)
file.export(); // Triggers a browser download of the file (no return value)
await file.rename(newName); // Rename file in vault
await file.delete(); // Delete file from vault
await file.undo(); // Load previous version
await file.redo(); // Load next version

// Options
useFile(name, initialContent, {
	autoSave: true | false,
	autoSaveDelay: milliseconds,
	mime,
	passphrase,
});
// - autoSave: enabled by default; autoSaveDelay defaults to 3000 ms
// - initialContent: if provided and not authenticated, it initializes the in-memory bytes
// - passphrase: optional per-file init fallback (attempts WM.init)
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
  hash: "abc123...",           // BLAKE3 of content (content-address)
  sig: "def456...",            // Ed25519 signature over the compressed chain bytes' hash
  key: "sk_789...",            // Storage key / content identifier
  size: 1024,                    // Original content size
  ts: 1703123456789,             // Creation timestamp
  parentHash: "xyz999..."      // Links to previous version
}
```

### Verification Process

```
// HashFS automatically verifies:
1. Content matches its BLAKE3 content-address (integrity)
2. Chain authenticity via Ed25519 signature (signatures over chain hash)
3. Chain integrity via binary hash concatenation with domain separation
4. Individual version signatures and hashes
5. Automatic recovery from corrupted versions

// Implementation notes:
// - Chain JSON is serialized and DEFLATE-compressed, then the compressed bytes are hashed (BLAKE3) and signed with Ed25519.
// - Chain hash is computed using binary concatenation of version hashes with domain separation ('HashFS-Chain-v6').
// - The compressed bytes are then encrypted with AES-GCM and stored in IndexedDB together with the signature field.
// - On load the encrypted payload is decrypted, the compressed bytes' hash is verified against the stored signature, and finally the JSON is inflated and parsed.
// - Legacy chains without chain hash are automatically migrated to the new format.
// Any verification failure prevents access to the chain.
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
- **BLAKE3** - Fast, secure content addressing and hashing
- **scrypt** - Memory-hard key derivation (N=2^17, r=8, p=1)
- **HKDF** - Key separation for signing and encryption
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
@noble/hashes   (BLAKE3, scrypt, HKDF)
@noble/ciphers  (AES-256-GCM)
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

- **@noble/curves** - Secure, audited Ed25519 signatures
- **@noble/hashes** - Fast, secure BLAKE3 and scrypt implementations
- **@noble/ciphers** - Industry-standard AES-GCM encryption
- **Vue.js** - Reactive framework foundation
- **fflate** - Fast, reliable compression
- **IndexedDB** - Browser-native storage

---

**🔒 Security Notice**: HashFS provides strong cryptographic protection, but no system is perfect. Always follow security best practices and consider your specific threat model when storing sensitive data. The zero-leak design means lost passphrases cannot be recovered - keep secure backups.
