# HashFS 🔐

**Zero-leak encrypted browser storage with cryptographic hash chains**

HashFS is a production-ready Vue 3 composable that provides military-grade encrypted file storage directly in your browser. It combines content-addressable storage, Ed25519 signatures, and cryptographic hash chains to create a zero-trust file vault with complete privacy - no servers, no tracking, no data leaks.

## ✨ Core Features

- 🔒 **Zero-leak privacy** - Everything encrypted client-side, nothing leaves your browser
- 🔗 **Hash chain integrity** - Cryptographic verification of entire file history
- 🖋️ **Ed25519 signatures** - Tamper-proof authenticity for every version
- 📦 **Content addressing** - SHA-256 deduplication with automatic compression
- ⏱️ **Version control** - Immutable history with configurable retention
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

### Complete Example

```vue
<template>
	<div v-if="!auth" class="login">
		<input
			v-model="passphrase"
			type="password"
			placeholder="Enter passphrase"
		/>
		<button @click="login()" :disabled="loading">Unlock Vault</button>
	</div>

	<div v-else class="vault">
		<!-- File Browser -->
		<div class="sidebar">
			<h3>Files ({{ files.length }})</h3>
			<div
				v-for="file in files"
				:key="file.name"
				:class="{ active: file.active }"
				class="file-item"
			>
				<span @click="selectFile(file.name)">{{ file.name }}</span>
				<small>{{ formatSize(file.size) }} • v{{ file.versions }}</small>
				<button @click="deleteFile(file.name)">×</button>
			</div>

			<button @click="newFile()">+ New File</button>
			<input type="file" @change="importFile($event.target.files[0])" />
		</div>

		<!-- Editor -->
		<div class="editor">
			<div v-if="currentFile" class="editor-header">
				<h2>{{ currentFile }}</h2>
				<span v-if="isDirty" class="dirty">●</span>
				<button @click="exportFile()">Export</button>
				<select v-model="currentMime">
					<option value="text/markdown">Markdown</option>
					<option value="text/plain">Text</option>
					<option value="application/json">JSON</option>
				</select>
			</div>

			<textarea
				v-if="currentFile"
				v-model="contentText"
				placeholder="Start typing..."
				class="content"
			></textarea>

			<div v-else class="welcome">
				<h3>Secure Encrypted Vault</h3>
				<p>Create a new file or select an existing one to begin.</p>
			</div>
		</div>
	</div>
</template>

<script setup>
	import { ref } from "vue";
	import { useHashFS } from "hashfs";

	const passphrase = ref("");

	const {
		// State
		auth,
		loading,
		files,
		currentFile,
		currentMime,
		contentText,
		isDirty,

		// Core operations
		login: loginCore,
		saveFile,
		selectFile,
		newFile,
		deleteFile,
		importFile,
		exportFile,
		exportAll,
	} = useHashFS();

	const login = async () => {
		if (!passphrase.value.trim()) return;
		const vault = useHashFS(passphrase.value);
		await vault.login();
	};

	const formatSize = (bytes) => {
		const units = ["B", "KB", "MB", "GB"];
		let size = bytes,
			unit = 0;
		while (size >= 1024 && unit < units.length - 1) {
			size /= 1024;
			unit++;
		}
		return `${Math.round(size * 10) / 10}${units[unit]}`;
	};
</script>

<style>
	.vault {
		display: flex;
		height: 100vh;
	}
	.sidebar {
		width: 300px;
		padding: 1rem;
		border-right: 1px solid #ddd;
	}
	.editor {
		flex: 1;
		padding: 1rem;
	}
	.file-item {
		padding: 0.5rem;
		cursor: pointer;
	}
	.file-item.active {
		background: #e3f2fd;
	}
	.content {
		width: 100%;
		height: 80vh;
		resize: vertical;
	}
	.dirty {
		color: #ff9800;
	}
</style>
```

## 📚 Complete API

### State Properties

```javascript
const {
	auth, // Ref<boolean> - Vault unlocked status
	loading, // Ref<boolean> - Operation in progress
	files, // ComputedRef<FileInfo[]> - All files with metadata
	currentFile, // ComputedRef<string> - Active file name
	currentMime, // ComputedRef<string> - Active file MIME type
	contentText, // ComputedRef<string> - Text content (reactive)
	contentBytes, // ComputedRef<Uint8Array> - Binary content
	isDirty, // ComputedRef<boolean> - Has unsaved changes
} = useHashFS(passphrase);
```

### Core Operations

```javascript
// Authentication
await login(); // Unlock vault with passphrase
// Throws on wrong passphrase

// File Management
await selectFile("readme.md"); // Load file for editing
const created = newFile("new.txt"); // Create file (returns boolean)
await deleteFile("old.txt"); // Permanently delete
await renameFile("old", "new"); // Rename preserving history

// Content Operations
contentText.value = "New content"; // Auto-saves after 800ms
await saveFile(); // Manual save with versioning

// Import/Export
await importFile(fileObject); // Import from device
exportFile(); // Download current file
const backup = await exportAll(); // Export all as object
```

### File Metadata

```javascript
// Each file in the files array contains:
{
  name: "document.md",           // File name
  mime: "text/markdown",         // MIME type
  versions: 5,                   // Number of versions
  size: 2048,                   // Uncompressed size
  compressedSize: 1024,         // Storage size
  modified: 1703123456789,      // Last modified timestamp
  active: true                  // Currently selected
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

- **AES-256-GCM** - Military-grade authenticated encryption
- **Ed25519** - State-of-the-art elliptic curve signatures
- **SHA-256** - Collision-resistant content addressing
- **PBKDF2** - 120,000 iterations against rainbow tables
- **Random IVs** - Fresh entropy for every encryption

### Integrity Protection

- **Hash chains** - Detect any tampering with version history
- **Content addressing** - Impossible to modify without changing hash
- **Cryptographic signatures** - Prove authenticity of every change
- **Atomic transactions** - Prevent corruption from interrupted operations

## ⚙️ Advanced Usage

### Custom Configuration

```javascript
// Modify retention policy
const vault = useHashFS(passphrase, {
	maxVersions: 20, // Keep 20 versions (default: 15)
	cacheSize: 5, // Cache 5 chains in memory (default: 10)
	autoSaveDelay: 1000, // Auto-save after 1s (default: 800ms)
});

// Export with metadata
const fullBackup = await exportAll({
	includeVersions: true, // Include full version history
	includeSigs: true, // Include cryptographic signatures
});
```

### Manual Verification

```javascript
// Verify file integrity manually
const isValid = await vault.verifyFile("document.md");
if (!isValid) {
	console.error("File has been tampered with!");
}

// Verify entire vault
const corrupt = await vault.verifyAll();
console.log("Corrupt files:", corrupt);
```

### Recovery Operations

```javascript
// Clean up ghost files and orphaned data
await vault.cleanup();

// Rebuild corrupted chains (advanced)
await vault.rebuildChains();

// Emergency export (bypasses verification)
const emergency = await vault.emergencyExport();
```

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
WebCrypto API   (AES-256-GCM)
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

## 📄 License

Contact the author for licencing details.

## 🙏 Acknowledgments

Built on audited cryptographic primitives:

- **@noble/crypto** - Secure, audited cryptography
- **Vue.js** - Reactive framework foundation
- **fflate** - Fast, reliable compression
- **IndexedDB** - Browser-native storage

---

**🔒 Security Notice**: HashFS provides strong cryptographic protection, but no system is perfect. Always follow security best practices and consider your specific threat model when storing sensitive data. The zero-leak design means lost passphrases cannot be recovered - keep secure backups.
