<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useHashFS, useFile } from './index.js'
import ChatDemo from './chat/ChatDemo.vue'
import { version } from '../package.json'

const props = defineProps({
  passphrase: { type: String, required: true }
})

const {
  auth, files, stats, loading, close, importAll, exportZip, importZip, downloadVault
} = useHashFS(props.passphrase)

const selectedFile = ref('')
const showRenameDialog = ref(false)
const renameTarget = ref('')
const newName = ref('')
const dragOver = ref(false)
const fileInput = ref(null)
const zipInput = ref(null)
const progressInfo = ref(null)

// Simple chat demo toggle state
const showChatDemo = ref(false)

function openChatDemo() {
  showChatDemo.value = true
}

const currentFile = computed(() =>
  selectedFile.value ? useFile(selectedFile.value) : null
)

const canUndo = computed(() => !!(currentFile.value && currentFile.value.canUndo && currentFile.value.canUndo.value))
const canRedo = computed(() => !!(currentFile.value && currentFile.value.canRedo && currentFile.value.canRedo.value))
const currentVersion = computed(() => currentFile.value?.currentVersion?.value ?? 0)
const availableVersions = computed(() => currentFile.value?.availableVersions?.value ?? { min: 0, max: 0 })
const currentMime = computed(() => currentFile.value?.mime?.value ?? '')
const currentLoading = computed(() => !!(currentFile.value && currentFile.value.loading && currentFile.value.loading.value))
const currentDirty = computed(() => !!(currentFile.value && currentFile.value.dirty && currentFile.value.dirty.value))
const currentBytesLength = computed(() => currentFile.value?.bytes?.value?.length ?? 0)
const currentText = computed({
  get: () => currentFile.value?.text?.value ?? '',
  set: (v) => { if (currentFile.value?.text) currentFile.value.text.value = v }
})

const hasFiles = computed(() => files.value.length > 0)
const canEdit = computed(() => {
  if (!currentFile.value) return false
  const mime = currentFile.value.mime.value
  return isTextMime(mime) && currentFile.value.bytes.value.length <= 5 * 1024 * 1024
})
const isImage = computed(() => {
  if (!currentFile.value) return false
  const mime = currentFile.value.mime.value
  const name = currentFile.value.filename
  return /^image\//.test(mime) || /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(name)
})

const blobUrl = ref(null)
watch([() => currentFile.value?.bytes.value, () => currentFile.value?.mime.value, isImage], () => {
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value)
    blobUrl.value = null
  }
  if (isImage.value && currentFile.value?.bytes.value?.length) {
    try {
      const blob = new Blob([currentFile.value.bytes.value], {
        type: currentFile.value.mime.value || 'image/png'
      })
      blobUrl.value = URL.createObjectURL(blob)
    } catch { /* ignore */ }
  }
}, { immediate: true })

onBeforeUnmount(() => {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value)
})

const statusText = computed(() => {
  if (loading.value) return '🔄 Initializing...'
  if (!currentFile.value) return '✅ Ready'
  if (currentFile.value.loading.value) return '📄 Working...'
  if (currentFile.value.dirty.value) return '📝 Unsaved changes'
  return '✅ Ready'
})


function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isTextMime(mime) {
  if (!mime) return true
  return /^text\//.test(mime) ||
    /(json|js|vue|xml|svg|turtle|trig|sparql|sql|csv|yaml|yml|md|markdown|javascript|typescript)/i.test(mime)
}

function formatDate(ts) {
  if (!ts) return 'Unknown'
  const now = Date.now()
  const diff = now - ts

  if (diff < 60000) return 'Just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`

  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

function getCompressionRatio(originalSize, compressedSize) {
  if (!originalSize || !compressedSize) return 0
  return ((originalSize - compressedSize) / originalSize) * 100
}

function handleProgress(progress) {
  progressInfo.value = progress
}

async function handleImport(fileList) {
  if (!fileList?.length) return

  try {
    progressInfo.value = { completed: 0, total: fileList.length, current: '' }
    const results = await importAll(Array.from(fileList), handleProgress)
    handleImportResults(results)
  } catch (error) {
    console.error('Import error:', error)
    alert(`Import failed: ${error.message}`)
  } finally {
    progressInfo.value = null
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function handleImportZip(fileList) {
  if (!fileList?.length) return
  const zipFile = fileList[0]
  if (!zipFile.name.endsWith('.zip')) {
    alert('Please select a ZIP file')
    return
  }

  try {
    progressInfo.value = { completed: 0, total: 1, current: zipFile.name }
    const arrayBuffer = await zipFile.arrayBuffer()
    const results = await importZip(arrayBuffer, handleProgress)
    handleImportResults(results)
  } catch (error) {
    console.error('ZIP import error:', error)
    alert(`ZIP import failed: ${error.message}`)
  } finally {
    progressInfo.value = null
    if (zipInput.value) zipInput.value.value = ''
  }
}

function handleImportResults(results) {
  const failed = results.filter(r => !r.success)
  const succeeded = results.filter(r => r.success)

  if (succeeded.length > 0) {
    console.log(`Successfully imported: ${succeeded.map(s => s.name).join(', ')}`)
    if (succeeded.length === 1) {
      selectedFile.value = succeeded[0].name
    }
  }

  if (failed.length > 0) {
    const errorDetails = failed.map(f => `${f.name}: ${f.error}`).join(' ')
    console.error('Import failures:', errorDetails)
    alert(`Import failed:
${errorDetails}`)
  }
}

async function handleNewFile() {
  const name = prompt('Enter file name:')?.trim()
  if (!name) return

  if (files.value.find(f => f.name === name)) {
    alert('File already exists')
    return
  }

  selectedFile.value = name
}

function selectFile(filename) {
  selectedFile.value = filename
}

async function startRename(fileName) {
  renameTarget.value = fileName
  newName.value = fileName
  showRenameDialog.value = true

  await nextTick()
  const input = document.querySelector('.rename-input')
  input?.select()
}

async function confirmRename() {
  if (!renameTarget.value || !newName.value || renameTarget.value === newName.value) {
    showRenameDialog.value = false
    return
  }

  try {
    const success = await useFile(renameTarget.value).rename(newName.value)

    if (!success) {
      alert('Rename failed - file may already exist')
      return
    }

    if (selectedFile.value === renameTarget.value) {
      selectedFile.value = newName.value
    }

    showRenameDialog.value = false
  } catch (error) {
    alert(`Rename failed: ${error.message}`)
  }
}

function cancelRename() {
  showRenameDialog.value = false
  renameTarget.value = ''
  newName.value = ''
}

async function confirmDelete(fileName) {
  if (!confirm(`Delete "${fileName}" permanently?`)) return

  try {
    await useFile(fileName).delete()

    if (selectedFile.value === fileName) {
      selectedFile.value = ''
    }
  } catch (error) {
    alert(`Delete failed: ${error.message}`)
  }
}

async function handleExportZip() {
  try {
    progressInfo.value = { completed: 0, total: files.value.length, current: '' }
    await downloadVault(`vault-${Date.now()}.zip`, handleProgress)
  } catch (error) {
    alert(`Export failed: ${error.message}`)
  } finally {
    progressInfo.value = null
  }
}

function handleDragOver(e) {
  e.preventDefault()
  dragOver.value = true
}

function handleDragLeave() {
  dragOver.value = false
}

async function handleDrop(e) {
  e.preventDefault()
  dragOver.value = false
  const files = e.dataTransfer.files

  if (files.length === 1 && files[0].name.endsWith('.zip')) {
    await handleImportZip(files)
  } else {
    await handleImport(files)
  }
}



function handleKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    if (e.shiftKey) {
      currentFile.value?.canRedo && currentFile.value.redo();
    } else {
      currentFile.value?.canUndo && currentFile.value.undo();
    }
    e.preventDefault();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    currentFile.value?.save && currentFile.value.save();
    e.preventDefault();
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(async () => {
  window.removeEventListener('keydown', handleKeydown)
  await close()
})
</script>

<template lang="pug">
.hashfs-vault.font-mono.mx-auto.max-w-7xl.px-4.py-6.min-h-screen(
  @dragover="handleDragOver"
  @dragleave="handleDragLeave"
  @drop="handleDrop"
  :class="{ 'bg-blue-50 border-2 border-dashed border-blue-400 rounded-lg': dragOver }"
)
  //- Header
  header.flex.items-center.justify-between.mb-6.pb-4.border-b.border-stone-300.gap-2
    .flex.items-center.gap-3.gap-2
      img.w-10(:src="'/logo.svg'")
      h1.m-0.text-2xl.font-bold.text-stone-800.flex.items-center.gap-2 #FS 
      a.text-xs.op-40(href="https://www.npmjs.com/package/hashfs" target="_blank") v.{{ version }}
      .text-sm.text-stone-500.px-2.py-1.bg-stone-100.rounded {{ statusText }}

    .flex.items-center.gap-2(v-if="auth")
      button.px-3.py-2.rounded.bg-blue-600.text-white.hover-bg-blue-700.transition.text-sm.font-medium(
        @click="handleNewFile"
        :disabled="loading"
        title="Create new file (Ctrl+N)"
      ) 📄 New

      label.px-3.py-2.rounded.border.border-stone-300.bg-white.text-stone-700.hover-bg-stone-50.transition.cursor-pointer.text-sm.font-medium(
        :class="{ 'opacity-50 cursor-not-allowed': loading }"
        title="Import files"
      )
        | 📥 Import Files
        input.hidden(
          ref="fileInput"
          type="file"
          multiple
          :disabled="loading"
          @change="handleImport($event.target.files)"
        )

      label.px-3.py-2.rounded.border.border-stone-300.bg-white.text-stone-700.hover-bg-stone-50.transition.cursor-pointer.text-sm.font-medium(
        :class="{ 'opacity-50 cursor-not-allowed': loading }"
        title="Import vault from ZIP"
      )
        | 📦 Import ZIP
        input.hidden(
          ref="zipInput"
          type="file"
          accept=".zip"
          :disabled="loading"
          @change="handleImportZip($event.target.files)"
        )

      button.px-3.py-2.rounded.border.border-stone-300.bg-white.text-stone-700.hover-bg-stone-50.transition.text-sm.font-medium(
        @click="openChatDemo"
        :disabled="loading"
        title="Open Chat Demo"
      ) 💬 Chat Demo

      button.px-3.py-2.rounded.border.border-stone-300.bg-white.text-stone-700.hover-bg-stone-50.transition.text-sm.font-medium(
        v-if="hasFiles"
        @click="handleExportZip"
        :disabled="loading"
        title="Download vault as ZIP"
      ) 📦 Download ZIP

  //- Progress Bar
  .mb-4(v-if="progressInfo")
    .bg-stone-200.rounded-full.h-2.overflow-hidden
      .bg-blue-600.h-full.transition-all.duration-300(
        :style="{ width: `${(progressInfo.completed / progressInfo.total) * 100}%` }"
      )
    .text-xs.text-stone-600.mt-1.flex.justify-between
      span Processing: {{ progressInfo.current }}
      span {{ progressInfo.completed }} / {{ progressInfo.total }}

  //- Chat Demo
  ChatDemo(v-if="auth && showChatDemo" @close="showChatDemo = false" :namespace="'chat'" :space="'demo'" :chunkSize="200")
  //- Main Content
  .grid.grid-cols-2.gap-2.min-h-600px(v-if="auth && !showChatDemo")
    //- Sidebar - File List
    .bg-stone-50.rounded-lg.border.border-stone-200
      .p-4.border-b.border-stone-200.bg-white.rounded-t-lg
        .flex.items-center.justify-between.mb-2
          h3.m-0.font-semibold.text-stone-800 Files ({{ files.length }})

        .text-xs.text-stone-500.space-y-1(v-if="hasFiles")
          .flex.justify-between
            span Original:
            span.font-mono {{ formatSize(stats.totalSize) }}
          .flex.justify-between
            span Compressed:
            span.font-mono {{ formatSize(stats.compressedSize) }}
          .flex.justify-between
            span Saved:
            span.font-mono.text-green-600 {{ stats.compressionRatio.toFixed(1) }}%
          .flex.justify-between.border-t.border-stone-200.pt-1
            span Est. DB size:
            span.font-mono.font-medium {{ formatSize(stats.estimatedDbSize) }}

      .p-3.max-h-60svh.overflow-y-auto
        .space-y-2(v-if="hasFiles")
          .group.p-3.rounded-lg.border.cursor-pointer.transition-all.hover-shadow-sm(
            v-for="file in files"
            :key="file.name"
            @click="selectFile(file.name)"
            :class="selectedFile === file.name ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-stone-200 bg-white hover:border-stone-300'"
          )
            .flex.items-start.justify-between.mb-2
              .flex-1.min-w-0
                .font-medium.truncate(
                  :class="selectedFile === file.name ? 'text-blue-700' : 'text-stone-800'"
                ) {{ file.name }}
                .text-xs.text-stone-500.mt-1 {{ file.mime }}

              .flex.gap-1.opacity-0.group-hover-opacity-100.transition-opacity
                button.p-2.rounded.hover-bg-stone-200.transition(
                  @click.stop="startRename(file.name)"
                  title="Rename"
                ) ✏️
                button.p-2.rounded.hover-bg-red-100.text-red-600.transition(
                  @click.stop="confirmDelete(file.name)"
                  title="Delete"
                ) 🗑️

            .flex.items-center.justify-between.text-xs.text-stone-500
              .flex.flex-col.gap-1
                span {{ formatSize(file.size) }} • v{{ file.versions }}
                span.text-green-600(v-if="file.compressedSize")
                  | {{ formatSize(file.compressedSize) }} (-{{ getCompressionRatio(file.size, file.compressedSize).toFixed(1) }}%)
              span {{ formatDate(file.modified) }}

        //- Empty State
        .text-center.py-12.px-4(v-else)
          .text-5xl.mb-3 📁
          p.text-stone-500.font-medium.mb-2 No files yet
          p.text-xs.text-stone-400 Create a new file or drop files here

    //- Editor Area
    .bg-white.rounded-lg.border.border-stone-200.flex.flex-col
      //- Editor Header
      .flex.items-center.justify-between.border-b.border-stone-200.p-4(v-if="currentFile")
        .flex.items-center.gap-2.w-full
          //- Version info
          .text-sm.text-stone-600.px-2(v-if="availableVersions.max > 0")
            | v.{{ currentVersion }} 
            span.text-stone-400 ({{ availableVersions.min }}-{{ availableVersions.max }} available)
          .flex-auto
          //- Undo/Redo buttons  
          button.px-2.py-1.rounded.bg-stone-100.text-stone-700.hover-bg-stone-200.transition.disabled-opacity-50.disabled-cursor-not-allowed(
            :disabled="!canUndo"
            title="Undo (Ctrl+Z)"
            @click="currentFile.undo()"
          ) ↩ Undo 
            span(v-if="canUndo") {{ Math.max(0, currentVersion - (availableVersions.min || 0)) }}

          button.px-2.py-1.rounded.bg-stone-100.text-stone-700.hover-bg-stone-200.transition.disabled-opacity-50.disabled-cursor-not-allowed(
            :disabled="!canRedo"
            title="Redo (Ctrl+Shift+Z)"
            @click="currentFile.redo()"
          ) ↪ Redo 
            span(v-if="canRedo") {{ Math.max(0, (availableVersions.max || 0) - currentVersion) }}
      .px-6.py-4.border-b.border-stone-200.bg-stone-50(v-if="currentFile")
        .flex.items-center.justify-between
          .min-w-0.flex-1
            h3.m-0.font-semibold.text-stone-800.truncate {{ currentFile.filename }}
            .text-xs.text-stone-500.mt-1.flex.items-center.gap-3
              span {{ currentMime }}
              span {{ formatSize(currentBytesLength) }}
              span.text-orange-600.font-medium(v-if="currentDirty") ● Unsaved

          .flex.gap-2
            button.px-3.py-2.rounded.border.border-stone-300.bg-white.text-stone-700.hover-bg-stone-50.transition.text-sm(
              @click="currentFile.export()"
              :disabled="currentLoading"
              title="Export file (Ctrl+E)"
            ) 📤 Export

            button.px-3.py-2.rounded.bg-blue-600.text-white.hover-bg-blue-700.transition.text-sm.font-medium(
              @click="currentFile.save()"
              :disabled="currentLoading || !currentDirty"
              title="Save (Ctrl+S)"
            ) 💾 Save

      //- Editor Content
      .flex-1.flex.flex-col
        //- Text Editor
        textarea.flex-1.border-none.p-6.font-mono.text-sm.leading-relaxed.resize-none.outline-none.bg-white(
          v-if="canEdit"
          v-model="currentText"
          :disabled="currentLoading"
          placeholder="Start typing your content..."
          spellcheck="false"
        )

        //- Image Viewer
        .flex-1.flex.items-center.justify-center.bg-stone-50.p-6(
          v-else-if="isImage && blobUrl"
        )
          img.max-w-full.max-h-70vh.object-contain.rounded.shadow-lg(
            :src="blobUrl"
            :alt="currentFile.filename"
          )

        //- Binary File Info
        .flex-1.flex.flex-col.items-center.justify-center.bg-stone-50.p-10.text-center(
          v-else-if="currentFile"
        )
          .text-6xl.mb-4 📄
          h4.m-0.mb-2.font-semibold.text-stone-700 Binary File
            p.m-0.text-stone-500.mb-4 {{ formatSize(currentBytesLength) }} • {{ currentMime }}
          button.px-4.py-2.rounded.bg-blue-600.text-white.hover-bg-blue-700.transition(
            @click="currentFile.export()"
          ) 📤 Download File

        //- Welcome Screen
        .flex-1.flex.flex-col.items-center.justify-center.text-center.p-10(
          v-else-if="!currentFile?.loading.value && !loading"
        )
          .text-7xl.mb-4 🔒
          h2.m-0.mb-3.text-xl.font-bold.text-stone-700 Secure Vault
          p.m-0.text-stone-500.mb-6.max-w-md
            | Select a file from the sidebar or create a new one to get started.

          .text-xs.text-stone-400.space-y-1
            p Ctrl+N - New file
            p Ctrl+S - Save file
            p Ctrl+E - Export file
            p Drag & drop files to import

        //- Loading Screen
        .flex.flex-col.items-center.justify-center.min-h-300.text-center(v-else)
          .text-7xl.mb-4 🔒
          h2.text-xl.font-semibold.text-stone-700.mb-2 Secure Vault
          p.text-stone-500.mb-6 {{ loading ? 'Initializing worker...' : 'Loading file...' }}
          .w-6.h-6.border-2.border-stone-300.border-t-blue-600.rounded-full.animate-spin

  //- Rename Dialog
  .fixed.inset-0.bg-black-50.flex.items-center.justify-center.z-50.p-4(
    v-if="showRenameDialog"
  )
    .bg-white.rounded-lg.shadow-xl.w-full.max-w-md.p-6
      h3.m-0.mb-4.text-lg.font-semibold.text-stone-800 Rename File
      input.rename-input.w-full.px-3.py-2.border.border-stone-300.rounded.mb-4(
        v-model="newName"
        @keydown.enter="confirmRename"
        @keydown.escape="cancelRename"
        type="text"
        placeholder="Enter new file name"
      )
      .flex.justify-end.gap-3
        button.px-4.py-2.rounded.border.border-stone-300.bg-white.text-stone-700.hover-bg-stone-50.transition(
          @click="cancelRename"
        ) Cancel
        button.px-4.py-2.rounded.bg-blue-600.text-white.hover-bg-blue-700.transition(
          @click="confirmRename"
        ) Rename
</template>

<style scoped>
.overflow-y-auto::-webkit-scrollbar {
  width: 6px;
}

.overflow-y-auto::-webkit-scrollbar-track {
  background: #f1f5f9;
  border-radius: 3px;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 3px;
}

.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background: #94a3b8;
}

.chat-pane {
  max-height: 60svh; /* limit chat window height */
}
</style>