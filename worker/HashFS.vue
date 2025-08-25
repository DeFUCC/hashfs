// HashFS.vue - Optimized with UnoCSS and PUG
<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useHashFS } from './useHashFS.js';

const props = defineProps({
  passphrase: { type: String, required: true }
});

const storage = useHashFS();

// Reactive state
const showRename = ref(false);
const renameTarget = ref('');
const newName = ref('');
const dragOver = ref(false);
const fileInput = ref(null);
const currentFile = ref(null);

// Computed
const hasFiles = computed(() => storage.filesList.value.length > 0);
const totalSize = computed(() => storage.filesList.value.reduce((sum, f) => sum + (f.size || 0), 0));
const statusText = computed(() => {
  if (storage.loading.value) return '🔄 Working...';
  if (currentFile.value?.isDirty) return '📝 Unsaved';
  return '✅ Ready';
});

// File operations
async function handleLogin() {
  try {
    await storage.login(props.passphrase);
    if (storage.filesList.value.length > 0) {
      currentFile.value = storage.useFile(storage.filesList.value[0].name);
    }
  } catch (error) {
    alert('Login failed: ' + error.message);
  }
}

async function createFile() {
  const name = prompt('File name:')?.trim();
  if (name && !storage.filesList.value.find(f => f.name === name)) {
    currentFile.value = storage.useFile('');
    await currentFile.value.new(name);
  }
}

async function selectFile(name) {
  if (currentFile.value?.isDirty) await currentFile.value.save();
  currentFile.value = storage.useFile(name);
}

async function importFiles(files) {
  const file = files?.[0];
  if (!file) return;

  currentFile.value = storage.useFile('');
  await currentFile.value.import(file);
  if (fileInput.value) fileInput.value.value = '';
}

async function startRename(fileName) {
  renameTarget.value = fileName;
  newName.value = fileName;
  showRename.value = true;
  await nextTick();
  document.querySelector('.rename-input')?.select();
}

async function confirmRename() {
  if (renameTarget.value && newName.value !== renameTarget.value) {
    await currentFile.value?.rename(newName.value);
  }
  showRename.value = false;
}

// Drag & drop
function handleDrop(e) {
  e.preventDefault();
  dragOver.value = false;
  importFiles(e.dataTransfer.files);
}

// Utilities
function formatSize(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts) {
  if (!ts) return 'Unknown';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'Now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return new Date(ts).toLocaleDateString();
}

// Lifecycle
onMounted(() => {
  handleLogin();
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      switch (e.key) {
        case 's': e.preventDefault(); currentFile.value?.save(); break;
        case 'n': e.preventDefault(); createFile(); break;
        case 'e': e.preventDefault(); currentFile.value?.export(); break;
      }
    }
    if (e.key === 'Escape') showRename.value = false;
  });
});
</script>

<template lang="pug">
.hashfs-vault.font-mono.mx-auto.max-w-7xl.px-4.py-6.min-h-screen(
  v-if="storage"
  @dragover.prevent="dragOver = true"
  @dragleave="dragOver = false"  
  @drop="handleDrop"
  :class="dragOver ? 'bg-blue-50 border-2 border-dashed border-blue-400 rounded' : ''"
)

  //- Header
  header.flex.items-center.justify-between.mb-6.pb-4.border-b.border-stone-300
    .flex.items-center.gap-3
      h1.text-2xl.font-bold.text-stone-800 🔒 Secure Vault
      .text-sm.text-stone-500.px-2.py-1.bg-stone-100.rounded {{ statusText }}

    .flex.gap-2(v-if="storage.auth.value")
      button.btn.btn-primary(@click="createFile") 📄 New
      label.btn.btn-secondary.cursor-pointer
        | 📥 Import
        input.hidden(ref="fileInput" type="file" @change="importFiles($event.target.files)")
      button.btn.btn-secondary(
        v-if="hasFiles"
        @click="storage.exportAll"
        :disabled="storage.loading.value"
      ) 📦 Export All

  //- Main Content
  .grid.grid-cols-1.lg-grid-cols-2.gap-6.min-h-600px(v-if="storage.auth.value")

    //- File List
    .card
      .card-header
        h3 Files ({{ storage.filesList.value.length }})
        .text-xs.text-stone-500(v-if="hasFiles")
          .flex.justify-between
            span Total:
            span.font-mono {{ formatSize(totalSize) }}

      .card-body.max-h-400px.overflow-y-auto
        .space-y-2(v-if="hasFiles")
          .file-item(
            v-for="file in storage.filesList.value"
            :key="file.name"
            @click="selectFile(file.name)"
            :class="currentFile?.name.value === file.name ? 'active' : ''"
          )
            .flex.items-start.justify-between.mb-2
              .flex-1.min-w-0
                .font-medium.truncate {{ file.name }}
                .text-xs.text-stone-500.mt-1 {{ file.mime }}

              .action-buttons
                button.action-btn(@click.stop="startRename(file.name)" title="Rename") ✏️
                button.action-btn.text-red-600(
                  @click.stop="currentFile?.delete(); currentFile = null"
                  title="Delete"
                ) 🗑️

            .flex.justify-between.text-xs.text-stone-500
              span {{ formatSize(file.size) }} • v{{ file.versions }}
              span {{ formatDate(file.modified) }}

        //- Empty State
        .text-center.py-12(v-else)
          .text-5xl.mb-3 📁
          p.text-stone-500.font-medium No files yet
          p.text-xs.text-stone-400 Create or drop files here

    //- Editor
    .card.flex.flex-col
      .card-header(v-if="currentFile?.name.value")
        .flex.items-center.justify-between
          .min-w-0.flex-1
            h3.truncate {{ currentFile.name.value }}
            .text-xs.text-stone-500.flex.gap-3
              span {{ currentFile.mime.value }}
              span {{ formatSize(currentFile.text.value?.length || 0) }}
              span.text-orange-600(v-if="currentFile.isDirty.value") ● Unsaved

          .flex.gap-2
            button.btn.btn-secondary(
              @click="currentFile.export"
              :disabled="currentFile.isLoading.value"
            ) 📤 Export
            button.btn.btn-primary(
              @click="currentFile.save"
              :disabled="currentFile.isLoading.value || !currentFile.isDirty.value"
            ) 💾 Save

      //- Editor Content
      .flex-1.flex.flex-col
        textarea.flex-1.border-none.p-6.font-mono.text-sm.resize-none.outline-none(
          v-if="currentFile?.name.value"
          v-model="currentFile.text.value"
          :disabled="currentFile.isLoading.value"
          placeholder="Start typing..."
          spellcheck="false"
        )

        //- Welcome Screen
        .flex-1.flex.flex-col.items-center.justify-center.text-center.p-10(v-else)
          .text-7xl.mb-4 🔒
          h2.text-xl.font-semibold.text-stone-700.mb-3 Welcome to Secure Vault
          p.text-stone-500.mb-6.max-w-md Select a file or create a new one to get started.
          .text-xs.text-stone-400.space-y-1
            p Ctrl+N - New file
            p Ctrl+S - Save file  
            p Ctrl+E - Export file

  //- Rename Dialog
  .modal(v-if="showRename")
    .modal-content
      h3.mb-4 Rename File
      input.rename-input.w-full.input(
        v-model="newName"
        @keydown.enter="confirmRename"
        @keydown.escape="showRename = false"
        placeholder="Enter new name"
      )
      .flex.justify-end.gap-3.mt-4
        button.btn.btn-secondary(@click="showRename = false") Cancel
        button.btn.btn-primary(@click="confirmRename") Rename
</template>

<style scoped>
.btn {
  @apply px-3 py-2 rounded text-sm font-medium transition-colors;
}

.btn-primary {
  @apply bg-blue-600 text-white hover:bg-blue-700;
}

.btn-secondary {
  @apply border border-stone-300 bg-white text-stone-700 hover:bg-stone-50;
}

.btn:disabled {
  @apply opacity-50 cursor-not-allowed;
}

.card {
  @apply bg-stone-50 rounded-lg border border-stone-200;
}

.card-header {
  @apply p-4 border-b border-stone-200 bg-white rounded-t-lg;
}

.card-body {
  @apply p-3;
}

.file-item {
  @apply group p-3 rounded-lg border cursor-pointer transition-all border-stone-200 bg-white hover:border-stone-300 hover:shadow-sm;
}

.file-item.active {
  @apply border-blue-500 bg-blue-50 shadow-sm;
}

.action-buttons {
  @apply flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity;
}

.action-btn {
  @apply p-2 rounded hover:bg-stone-200 transition-colors;
}

.input {
  @apply px-3 py-2 border border-stone-300 rounded;
}

.modal {
  @apply fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4;
}

.modal-content {
  @apply bg-white rounded-lg shadow-xl w-full max-w-md p-6;
}

.overflow-y-auto::-webkit-scrollbar {
  @apply w-1.5;
}

.overflow-y-auto::-webkit-scrollbar-track {
  @apply bg-stone-100 rounded;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
  @apply bg-stone-300 rounded hover:bg-stone-400;
}
</style>