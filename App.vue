<script setup vapor>
import { ref, computed, watch, onMounted } from 'vue';
import HashFS from './src/HashFS.vue';
import { version } from './package.json'

const inp = ref('')
const passphrase = ref(null)

const STORAGE_KEY = 'hashfs_passphrase'

// Load from sessionStorage on mount
onMounted(() => {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY)
    if (saved) passphrase.value = saved
  } catch { }
})

// Keep sessionStorage in sync
watch(passphrase, (val) => {
  try {
    if (val) sessionStorage.setItem(STORAGE_KEY, val)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch { }
})

</script>

<template lang="pug">
.font-mono.mx-auto.flex.flex-col.gap-4
  form.p-4.flex.flex-col.gap-4.max-w-55ch.mx-auto(v-if="!passphrase" @submit.prevent="passphrase = inp; inp = null")
    img.w-30(:src="'/logo.svg'")
    .flex.items-baseline.gap-2
      .text-5xl HashFS
      .text-sm.op-50 v.{{ version }}
    .text-2xl Secure browser storage
    .text-lg Enter a long passphrase to open your vault
    input.bg-light-100.p-4.rounded-lg.text-center(v-model="inp" type="password")
    button.text-xl.p-4.shadow-lg.rounded-lg.bg-green-400(type="submit") Enter

    .text-sm.op-80 HashFS is a production-ready reactive Vue composable package that provides secure file persistence in the browser. It combines content-addressable storage, Ed25519 signatures, and cryptographic hash chains to create zero-trust file vaults with complete privacy - offline, no servers, no tracking, no data leaks.

    .mx-auto.rounded-xl.bg-stone-600.text-stone-200.p-4 npm install hashfs

    .flex.items-center.w-full.text-center.gap-4.justify-center
      a.flex.items-center.gap-2.bg-stone-700.p-4.rounded-xl.shadow-lg.text-stone-100(href="https://www.npmjs.com/package/hashfs" target="_blank") 
        .i-lucide-code
        span NPM
      a.flex.items-center.gap-2.bg-stone-700.p-4.rounded-xl.shadow-lg.text-stone-100(href="https://github.com/DeFUCC/hashfs" target="_blank") 
        .i-lucide-github
        span GitHub
      a.flex.items-center.gap-2.bg-stone-700.p-4.rounded-xl.shadow-lg.text-stone-100(href="https://www.youtube.com/watch?v=Mlb6c5E_PyI" target="_blank") 
        .i-lucide-youtube
        span YouTube

    pre.text-sm.w-full.rounded-xl.bg-stone-300.p-4.overflow-x-auto.whitespace-pre-wrap.break-words. 

      import { ref } from "vue"; // Vue is a peer dependency
      import { useHashFS, useFile } from "hashfs";

      const { auth, files, stats, loading, close, importAll, exportZip, importZip, downloadVault } = useHashFS("your-secure-passphrase")

      const  { loading, filename, mime, text, bytes, dirty, currentVersion, availableVersions, canUndo, canRedo, undo, redo, load, save, rename, delete: deleteFile, import: importFile, export: exportFile } = useFile()

  template(v-else)
    HashFS(:passphrase :key="passphrase") 
      button.text-sm.text-red-500.bg-white.rounded.flex.gap-2.px-2.py-1.rounded.border.border-stone-300(@click="passphrase = null; inp = null")
        .i-lucide-log-out
        span Log out

</template>

<style lang="postcss">
#app {
  @apply bg-stone-200 min-h-100svh;
}
</style>