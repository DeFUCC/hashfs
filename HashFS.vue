<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useHashFS } from './index';

const props = defineProps({
  passphrase: { type: String, required: true }
});

const {
  auth, loading, files, currentFile, currentMime, contentText, contentBytes, isDirty,
  login, saveFile, selectFile, newFile, deleteFile, renameFile,
  importFile, exportFile, exportAll
} = useHashFS(props.passphrase);


const renameTarget = ref('');
const newName = ref('');
const dragOver = ref(false);

// Computed helpers
const hasFiles = computed(() => files.value.length > 0);
const canEdit = computed(() => currentFile.value && isTextMime(currentMime.value));
const statusText = computed(() => {
  if (loading.value) return '🔄 Working...';
  if (isDirty.value) return '📝 Unsaved changes';
  return '✅ Ready';
});

// Preview helpers
const imageExtRE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff)$/i;
const isImage = computed(() => {
  const name = currentFile.value || '';
  const mime = currentMime.value || '';
  return /^image\//.test(mime) || imageExtRE.test(name);
});

const blobUrl = ref(null);
watch([contentBytes, currentMime, currentFile, isImage], () => {
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value);
    blobUrl.value = null;
  }
  if (isImage.value && contentBytes.value && contentBytes.value.length) {
    try {
      const blob = new Blob([contentBytes.value], { type: currentMime.value || 'application/octet-stream' });
      blobUrl.value = URL.createObjectURL(blob);
    } catch { /* ignore */ }
  }
}, { immediate: true });

onBeforeUnmount(() => {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
});

// Utility functions
function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isTextMime(mime) {
  if (!mime) return true;
  return /^text\//.test(mime) ||
    /(json|xml|svg|turtle|trig|sparql|sql|csv|yaml|yml|md|markdown)/i.test(mime);
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// File operations
async function handleImport(file) {
  if (!file) return;
  await importFile(file);
}

async function handleNewFile() {
  const name = prompt('Enter file name:')?.trim();
  if (name) await newFile(name);
}

const renameDialog = ref(null);

async function startRename(fileName) {
  renameTarget.value = fileName;
  newName.value = fileName;
  nextTick(() => {
    renameDialog.value.showModal();
    // Focus the input field when dialog opens
    const input = renameDialog.value.querySelector('input');
    input?.select();
  });
}

async function confirmRename(e) {
  e?.preventDefault();
  if (renameTarget.value && newName.value && renameTarget.value !== newName.value) {
    const success = await renameFile(renameTarget.value, newName.value);
    if (!success) {
      alert('Rename failed - file may already exist');
      return; // Don't close dialog on error
    }
  }
  renameDialog.value?.close();
}

// Drag & drop handlers
function handleDragOver(e) {
  e.preventDefault();
  dragOver.value = true;
}

function handleDragLeave(e) {
  e.preventDefault();
  dragOver.value = false;
}

async function handleDrop(e) {
  e.preventDefault();
  dragOver.value = false;
  const files = Array.from(e.dataTransfer.files);
  if (files.length > 0) {
    await handleImport(files[0]);
  }
}

// Keyboard shortcuts
function handleKeydown(e) {
  if (e.ctrlKey || e.metaKey) {
    switch (e.key) {
      case 's':
        e.preventDefault();
        saveFile();
        break;
      case 'n':
        e.preventDefault();
        handleNewFile();
        break;
    }
  }
}

onMounted(() => {
  login();
  window.addEventListener('keydown', handleKeydown);
  return () => window.removeEventListener('keydown', handleKeydown);
});
</script>

<template lang="pug">
.hashfs-vault.font-mono.mx-auto.max-w-6xl.px-4.py-6(
  @dragover="handleDragOver"
  @dragleave="handleDragLeave"
  @drop="handleDrop"
  :class="{ 'bg-blue-50 border-2 border-dashed border-blue-500 rounded-lg': dragOver }"
)

  header.flex.items-center.justify-between.mb-6.pb-4.border-b.border-stone-300
    h1.m-0.text-stone-800.flex.items-center.gap-2
      | 🔐 Secure Vault
      .text-sm.font-normal.text-stone-500 {{ statusText }}

    .header-actions.flex.gap-2(v-if="auth")
      button.px-4.py-2.rounded.border.border-stone-300.bg-white.text-stone-700.hover-bg-stone-100.transition(@click="handleNewFile" title="Create new file (Ctrl+N)")
        | 📄 New

      label.px-4.py-2.rounded.border.border-stone-300.bg-stone-200.text-stone-700.hover-bg-stone-300.transition.cursor-pointer(title="Import file")
        | 📥 Import
        input.hidden(type="file" @change="handleImport($event.target.files?.[0])")

      button.px-4.py-2.rounded.border.border-stone-300.bg-stone-200.text-stone-700.hover-bg-stone-300.transition(v-if="hasFiles" @click="exportAll" :disabled="loading" title="Export all files")
        | 📦 Export All

  // Rename Dialog
  dialog(ref="renameDialog" class="rounded-lg p-6 w-full max-w-md border-0 shadow-xl backdrop:bg-black/50")
    form(method="dialog" @submit="confirmRename" class="space-y-4")
      h3.mt-0.mb-4.text-lg.font-medium.text-stone-800 Rename File
      .space-y-4
        input.w-full.px-3.py-2.border.border-stone-300.rounded.mb-2(
          type="text"
          v-model="newName"
          required
          placeholder="Enter new file name"
          class="w-full"
        )
      .flex.justify-end.gap-3.mt-6
        button.px-4.py-2.rounded.border.border-stone-300.bg-white.text-stone-700.hover-bg-stone-100(type="button" @click="renameDialog.close()") Cancel
        button.px-4.py-2.rounded.bg-blue-600.text-white.hover-bg-blue-700(type="submit") Rename

  // Main content
  .main-content.grid(v-if="auth" class="min-h-[600px] grid-cols-1 md:grid-cols-[320px_1fr] gap-6")

    // Sidebar - File list
    .sidebar.bg-stone-100.rounded-lg.p-4
      h3.m-0.mb-3.text-stone-800.flex.items-center.justify-between
        span Files ({{ files.length }})
        .text-xs.text-stone-500.font-normal {{hasFiles ? `${files.reduce((sum, f) => sum + f.size, 0) | formatSize} total` : 'No files'}}

      .files-list.flex.flex-col.gap-2(v-if="hasFiles")
        .file-item.rounded-md.p-3.border.border-stone-300.bg-white.cursor-pointer.transition(
          v-for="file in files"
          :key="file.name"
          :class="{ 'border-blue-500 bg-blue-50 shadow-sm': file.active }"
          @click="selectFile(file.name)"
        )
          .file-header.flex.items-start.justify-between(class="mb-1.5")
            .file-name.font-600.text-stone-800.break-words.flex-1(:class="{ 'text-blue-600': file.active }") {{ file.name }}
            .file-actions.flex.gap-1.opacity-70
              button.p-1.rounded.hover-bg-stone-200(@click.stop="startRename(file.name)" title="Rename") ✏️
              button.p-1.rounded.text-red-600.hover-bg-red-50(@click.stop="deleteFile(file.name)" title="Delete") 🗑️

          .file-meta.text-xs.text-stone-500.flex.items-center.justify-between
            span {{ formatSize(file.size) }} • v{{ file.versions }}
            span {{ formatDate(file.modified) }}

          .file-type.text-xs.text-stone-400.mt-1 {{ file.mime }}

      .empty-state.text-center.py-10.px-5.text-stone-400(v-else)
        div.text-6xl.mb-2 📁
        p.m-0 No files yet
        p.text-xs.mt-1 Create a new file or drop files here

    // Main editor area
    .editor-area.bg-white.rounded-lg.border.border-stone-300.flex.flex-col

      // Editor header
      .editor-header.px-5.py-4.border-b.border-stone-300.bg-stone-100(v-if="currentFile")
        .file-info.flex.items-center.justify-between
          .current-file
            h3.m-0.text-stone-800 {{ currentFile }}
            .file-details.text-xs.text-stone-500
              span {{ currentMime }} • {{ formatSize(contentText.length) }}
              span.text-green-600.ml-2(v-if="isDirty") ● Unsaved

          .editor-actions.flex.gap-2
            button.px-3.py-2.rounded.border.border-stone-300.bg-white.text-stone-700.hover-bg-stone-100.transition(@click="exportFile" :disabled="loading" title="Export file")
              | 📤 Export
            button.px-3.py-2.rounded.border.border-blue-600.bg-blue-600.text-white.hover-bg-blue-700.transition(:disabled="loading || !isDirty" @click="saveFile" title="Save (Ctrl+S)")
              | 💾 Save

      // Editor content
      .editor-content.flex.flex-col.flex-1

        // Text editor
        textarea.flex-1.border-none.p-5.font-mono.text-sm.leading-6.resize-none.outline-none.bg-white(
          v-if="canEdit"
          v-model="contentText"
          :disabled="loading"
          placeholder="Start typing your content..."
          spellcheck="false"
        )

        // Image or binary view
        template(v-else-if="currentFile")
          // Image preview
          .flex-1.flex.items-center.justify-center.bg-stone-50.p-6(v-if="isImage && blobUrl")
            img.object-contain.rounded.shadow(class="max-w-full max-h-[70vh]" :src="blobUrl" :alt="currentFile")
          // Generic binary info
          .flex-1.flex.flex-col.items-center.justify-center.bg-stone-50.p-10(v-else)
            .text-6xl.mb-2 📎
            h4.m-0.mb-2.text-stone-700 Binary File
            p.m-0.text-stone-500 {{ formatSize(contentText.length) }} • {{ currentMime }}
            p.text-xs.text-stone-400.mt-2 Use Export to download this file

        // Welcome screen
        .welcome.flex-1.flex.flex-col.items-center.justify-center.text-stone-500.px-10.py-14(v-else)
          div.text-7xl.mb-4 🔐
          h2.m-0.mb-3.text-stone-700 Welcome to Secure Vault
          p.m-0.text-base Select a file from the sidebar or create a new one to get started.
          .shortcuts.mt-5.text-xs.text-stone-400
            p.my-1 Ctrl+N - New file
            p.my-1 Ctrl+S - Save file
            p.my-1 Drag & drop - Import files

  // Login prompt
  .login-prompt.text-center.px-10.py-14(v-else)
    div.text-7xl.mb-4 🔐
    h2.text-stone-700.mb-2 Secure Vault
    p.text-stone-500.mb-6 Initializing encrypted storage...
    .inline-block.w-5.h-5.border-2.border-stone-300.border-t-blue-600.rounded-full.animate-spin(v-if="loading")
</template>