<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useHashFS } from './index';

const props = defineProps({
  passphrase: { type: String }
});

const {
  auth, loading, filesList, currentFile, currentMime, contentText, contentBytes,
  login, loadFile, newFile, deleteFile, importFile, exportFile, saveFile
} = useHashFS(props.passphrase)

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


function isTextMime(mime) {
  if (!mime) return true;
  return /^text\//.test(mime) || /(json|xml|svg|turtle|trig|sparql|sql|csv|yaml|yml)/i.test(mime);
}

onMounted(login);

</script>

<template lang="pug">
div(style="font-family: monospace; max-width: 1200px; margin: 20px;")
  h1 🔒 Secure Vault {{ loading ? '🔓 Working...' : '🔓 Ready' }}
  div(v-if="auth")
    div(style="margin-bottom: 20px;")
      button(@click="newFile", style="margin-right: 10px;") 📄 New
      label(@click="importFile", style="margin-right: 10px;") 📥 Import
        input(type="file", @change="importFile($event.target.files?.[0])", style="display: none;")
      button(v-if="currentFile", @click="exportFile", style="margin-right: 10px;") 📤 Export
      button(v-if="currentFile", @click="saveFile", :disabled="loading") 💾 Save
      span(v-if="currentFile", style="margin-left: 20px; color: #666;") Current: 
        strong {{ currentFile }}
    div(v-if="filesList.length")
      h3 Files ({{ filesList.length }}):
      div(v-for="file in filesList", :key="file.name", :style="{ padding: '8px', border: file.active ? '2px solid #007acc' : '1px solid #ddd', marginBottom: '5px', backgroundColor: file.active ? '#f0f8ff' : 'white' }")
        div(style="display: flex; justify-content: space-between; align-items: center;")
          div
            button(@click="loadFile(file.name)", style="margin-right: 10px; font-weight: bold;") {{ file.name }} ({{ file.mime }})

            span(style="color: #666; font-size: 0.9em;") {{ formatSize(file.size) }} • v{{ file.versions }}

              span(v-if="file.hash", style="margin-left: 10px; font-family: monospace;") {{ file.hash.slice(0, 8) }}...

          div
            span(style="color: #999; font-size: 0.8em; margin-right: 10px;") {{ new Date(file.modified).toLocaleString() }}
            button(@click="deleteFile(file.name)", style="color: red;") 🗑️
    div(v-if="currentFile")
      h3 {{ currentFile }}
      div(v-if="isTextMime(currentMime)")
        textarea(v-model="contentText", :disabled="loading", rows="25", style="width: 100%; font-family: monospace; padding: 10px; border: 1px solid #ddd;", placeholder="Enter content...")         
      div(v-else, style="padding: 10px; border: 1px dashed #ddd; color: #555;")
        p Binary file ({{ formatSize((contentBytes?.length) || 0) }})
      div(style="margin-top: 10px; color: #666; font-size: 0.9em;") Type: {{ currentMime }} • Size: {{ formatSize((contentBytes?.length) || 0) }}
        
</template>