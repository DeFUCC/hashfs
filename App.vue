<script setup vapor>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import HashFS from './main/HashFS.vue';

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
    .text-2xl HashFS
    .text-lg Enter a passphrase  to enter your vault
    input.bg-light-100.p-4.rounded-lg.text-center(v-model="inp" type="password")
    button.text-xl.p-4.shadow-lg.rounded-lg.bg-green-400(type="submit") Enter
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