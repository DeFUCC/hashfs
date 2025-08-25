<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import HashFS from './main/HashFS.vue';
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
.font-mono.mx-auto.pt-20.flex.flex-col.gap-4
  form.p-4.text-center.flex.flex-col.gap-4.max-w-55ch.mx-auto(v-if="!passphrase" @submit.prevent="passphrase = inp; inp = null")
    .text-5xl HashFS
    .text-2xl Encrypted browser storage demo
    .text-lg Enter a long passphrase to open your vault
    input.bg-light-100.p-4.rounded-lg.text-center(v-model="inp" type="password")
    button.text-xl.p-4.shadow-lg.rounded-lg.bg-green-400(type="submit") Enter

    .text-sm.op-80 HashFS is a production-ready Vue 3 composable that provides military-grade encrypted file storage directly in your browser. It combines content-addressable storage, Ed25519 signatures, and cryptographic hash chains to create a zero-trust file vault with complete privacy - no servers, no tracking, no data leaks.

    .flex.items-center.w-full.text-center.gap-4.justify-center
      a.text-sm.op-80 v.{{ version }}
      a.text-sm.op-80(href="https://www.npmjs.com/package/hashfs" target="_blank") NPM
      a.text-sm.op-80(href="https://github.com/DeFUCC/hashfs" target="_blank") GitHub

  template(v-else)
    button.p-4.rounded-lg.absolute.top-4.right-4(@click="passphrase = null; inp = null")
      .i-lucide-x
    HashFS(:passphrase :key="passphrase")

</template>

<style lang="postcss">
#app {
  @apply bg-stone-200 min-h-100svh;
}
</style>