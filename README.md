# HashFS 🔐

**Content-addressed encrypted browser storage with cryptographic integrity**

HashFS is a production-ready Vue 3 composable that provides secure, encrypted file storage directly in the browser using IndexedDB. It combines content-addressable storage, military-grade encryption, and cryptographic signatures to create a zero-trust file vault that runs entirely client-side.

## ✨ Features

- 🔒 **End-to-end encryption** - AES-256-GCM with PBKDF2 key derivation
- 🖋️ **Cryptographic signatures** - Ed25519 signatures for authenticity verification  
- 📦 **Content-addressable storage** - SHA-256 hashing for deduplication and integrity
- 🗂️ **Version control** - Automatic versioning with configurable retention
- 💾 **Offline-first** - Works completely offline using IndexedDB
- ⚡ **Performance optimized** - Compression, efficient crypto, smart caching
- 🎨 **Vue 3 reactive** - Seamless integration with Vue applications
- 🛡️ **Zero-trust architecture** - Client-side only, no server dependencies

## 🔐 Security Architecture

HashFS implements a multi-layered security model:

### Key Derivation (PBKDF2)
```
Password → PBKDF2(120,000 iterations, SHA-256) → Master Key (64 bytes)
├─ Signing Key (32 bytes) → Ed25519 Private Key
├─ Encryption Key (32 bytes) → AES-256-GCM Key  
└─ Database ID (16 bytes) → Unique vault identifier
```

### Storage Process
```
Content → SHA-256 Hash → Ed25519 Sign → Deflate → AES-GCM Encrypt → IndexedDB
```

### Verification Process
```
IndexedDB → AES-GCM Decrypt → Inflate → SHA-256 Verify → Ed25519 Verify → Content
```

## 🚀 Quick Start

### Installation

```bash
pnpm install hashfs
```

### Basic Usage

```javascript
import { useHashFS } from 'hashfs'
const vault = useHashFS('your-secure-passphrase');    
```

### Complete Example

```vue
<template>
  <div v-if="auth">
    <h1>Secure Vault ({{ files.length }} files)</h1>
    
    <!-- File List -->
    <div v-for="file in files" :key="file.name">
      <button @click="selectFile(file.name)">
        {{ file.name }} ({{ formatSize(file.size) }})
      </button>
      <button @click="deleteFile(file.name)">Delete</button>
    </div>
    
    <!-- Editor -->
    <div v-if="currentFile">
      <h2>{{ currentFile }}</h2>
      <textarea v-model="contentText" rows="20" cols="80"></textarea>
      <button @click="saveFile" :disabled="!isDirty">Save</button>
    </div>
    
    <!-- Actions -->
    <button @click="newFile('readme.md')">New File</button>
    <input type="file" @change="importFile($event.target.files[0])" />
    <button @click="exportFile">Export Current</button>
  </div>
  
  <div v-else>
    <button @click="login">Unlock Vault</button>
  </div>
</template>

<script setup>
import { useHashFS } from 'hashfs'

const {
  // State
  auth, loading, files, currentFile, currentMime, contentText, isDirty,
  
  // Core
  login, saveFile,
  
  // File Operations  
  selectFile, newFile, deleteFile, renameFile,
  importFile, exportFile, exportAll
} = useHashFS('my-secure-passphrase');
</script>
```

## 📚 API Reference

### State Properties

| Property | Type | Description |
|----------|------|-------------|
| `auth` | `Ref<boolean>` | Authentication status |
| `loading` | `Ref<boolean>` | Loading state for async operations |
| `files` | `ComputedRef<FileInfo[]>` | Reactive list of all files |
| `currentFile` | `ComputedRef<string>` | Name of currently selected file |
| `currentMime` | `ComputedRef<string>` | MIME type of current file |
| `contentText` | `ComputedRef<string>` | Text content (get/set) |
| `isDirty` | `ComputedRef<boolean>` | Has unsaved changes |

### Core Methods

#### `login(): Promise<void>`
Authenticates and initializes the vault using the provided passphrase.

```javascript
await login(); // Uses passphrase from constructor
```

#### `saveFile(): Promise<void>`
Saves the current file with automatic versioning and integrity verification.

```javascript
// Auto-save on content changes (debounced 800ms)
contentText.value = "New content"; // Automatically saves

// Manual save
await saveFile();
```

### File Operations

#### `selectFile(name: string): Promise<void>`
Loads and decrypts a file for editing.

```javascript
await selectFile('document.md');
console.log(contentText.value); // Decrypted content
```

#### `newFile(name?: string): Promise<boolean>`
Creates a new file with optional name prompt.

```javascript
// With name
await newFile('notes.txt');

// With prompt
await newFile(); // Shows browser prompt
```

#### `deleteFile(name: string): Promise<void>`
Permanently deletes a file and all its versions.

```javascript
await deleteFile('old-document.md');
```

#### `renameFile(oldName: string, newName: string): Promise<boolean>`
Renames a file while preserving all versions.

```javascript
const success = await renameFile('draft.md', 'final.md');
```

#### `importFile(file: File): Promise<boolean>`
Imports a file from the user's device.

```javascript
const input = document.querySelector('input[type="file"]');
input.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  await importFile(file);
});
```

#### `exportFile(): void`
Downloads the current file to the user's device.

```javascript
exportFile(); // Downloads current file
```

#### `exportAll(): Promise<object>`
Exports all files as a serializable object.

```javascript
const backup = await exportAll();
console.log(backup); // { "file1.txt": { mime: "text/plain", content: [...] } }
```

## 🗂️ File Metadata Structure

Each file maintains comprehensive metadata:

```javascript
{
  name: "document.md",
  mime: "text/markdown", 
  versions: [
    {
      hash: "sha256-hash-of-content",
      sig: "ed25519-signature", 
      key: "hash:signature", // Storage key
      size: 1024, // Original size
      ts: 1703123456789 // Timestamp
    }
  ]
}
```

## 🔒 Security Features

### Content Addressing
Every file version is identified by its SHA-256 hash, ensuring:
- **Deduplication** - Identical content shares the same storage
- **Integrity** - Content tampering is immediately detected
- **Immutability** - Content cannot be changed without changing its address

### Cryptographic Signatures
Each file version includes an Ed25519 signature:
- **Authenticity** - Verifies content was created with your keys
- **Non-repudiation** - Proves you authored the content
- **Tamper detection** - Any modification invalidates the signature

### Encryption Pipeline
1. **Compression** - Deflate algorithm reduces storage size
2. **Encryption** - AES-256-GCM with random IV per file
3. **Authenticated encryption** - Built-in integrity protection
4. **Key isolation** - Each vault uses unique derived keys

### Version Control
- **Automatic versioning** - Each save creates a new immutable version
- **Configurable retention** - Keeps last 10 versions by default
- **Atomic operations** - Version creation is transactional
- **Garbage collection** - Automatic cleanup of orphaned data

## 🏗️ Architecture

### Storage Layer
```
Browser
├─ IndexedDB
│  ├─ files (content-addressed encrypted blobs)
│  └─ meta (encrypted metadata index)
└─ Memory (reactive Vue state)
```

### Cryptographic Stack
```
@noble/curves (Ed25519 signatures)
@noble/hashes (SHA-256, PBKDF2)
WebCrypto API (AES-256-GCM encryption)
```

### Vue Integration
```
Vue 3 Composition API
├─ Reactive state management
├─ Computed properties for UI binding  
├─ Auto-save with debouncing
└─ Lifecycle management
```

## 🔧 Advanced Configuration

### Custom Encryption Settings

```javascript
// Modify crypto parameters in the source
const cryptoUtils = {
  async deriveKeys(pwd) {
    // Increase iterations for higher security
    const masterKey = pbkdf2(sha256, pwdBytes, salt, { 
      c: 200000, // Increased from 120,000
      dkLen: 64 
    });
    // ...
  }
}
```

### Version Retention Policy

```javascript
// In saveFile(), modify retention limit
while (meta.versions.length > 20) { // Keep 20 versions instead of 10
  const old = meta.versions.shift();
  toDelete.push(old.key);
}
```

## 🛡️ Security Considerations

### Threat Model
HashFS protects against:
- ✅ **Data breaches** - All data encrypted at rest
- ✅ **Content tampering** - Cryptographic integrity verification  
- ✅ **Man-in-the-middle** - Client-side encryption
- ✅ **Unauthorized access** - Strong key derivation

### Limitations
- ❌ **Passphrase attacks** - Use strong, unique passphrases
- ❌ **Browser vulnerabilities** - Keep browser updated
- ❌ **Physical access** - Browser may cache decrypted data
- ❌ **Side-channel attacks** - JavaScript crypto limitations

### Best Practices

1. **Strong Passphrases** - Use 20+ character passphrases
2. **HTTPS Only** - WebCrypto requires secure contexts
3. **Regular Backups** - Export data periodically
4. **Browser Security** - Keep browser and extensions updated
5. **Private Browsing** - Consider for sensitive data

**Secure Context Required**: HTTPS or localhost only due to WebCrypto API restrictions.

## 🚧 Development

```bash
git clone https://github.com/yourusername/hashfs
cd hashfs
pnpm install
pnpm run dev
```


## 🙏 Acknowledgments

- **@noble/crypto** - Audited cryptographic primitives
- **Vue.js** - Reactive framework foundation
- **IndexedDB** - Browser storage substrate
- **fflate** - Fast compression library

---

**⚠️ Security Notice**: HashFS is designed for client-side data protection. While it uses industry-standard cryptography, no security system is perfect. Always follow security best practices and consider your threat model when storing sensitive data.