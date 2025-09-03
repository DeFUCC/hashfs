<script setup vapor>
import { ref, computed, nextTick, onMounted } from 'vue'
import { useChat } from '../index.js'

// Chat demo component moved under src/chat/

const emit = defineEmits(['close'])

// accept generic config from consumer; give UI-level defaults only
const props = defineProps({
  namespace: { type: String, required: true },
  space: { type: String, required: true },
  chunkSize: { type: Number, required: true }
})

// Chat demo state and helpers (encapsulated)
const chat = useChat({ namespace: props.namespace, chunkSize: props.chunkSize })
const convList = ref([])
const convPage = ref(1)
const loadingConvs = ref(false)
const selectedConvId = ref('')

// Double-ended message window: ids keep strict ascending order; map stores payload
const messageIds = ref([])
const messageMap = ref(new Map())
const displayedMessages = computed(() => {
  const ids = Array.from(messageIds.value)
  ids.sort((a, b) => a - b)
  return ids.map(id => messageMap.value.get(id)).filter(Boolean)
})

const chatPane = ref(null)
const loadingMsgs = ref(false)
const msgInput = ref('')
const autoReply = ref(false)
// Key to force remounting message list when necessary (to align DOM with data order)
const listKey = ref(0)

// Dev test harness state
const testRunning = ref(false)
const testLog = ref([])
function tlog(line) { testLog.value.push(line); console.log('[OrderTest]', line) }
// debug helpers
const debugIds = ref(false)
function dumpIds() {
  console.log('[Debug] messageIds:', JSON.stringify(messageIds.value))
  console.log('[Debug] displayedIds:', JSON.stringify(displayedMessages.value.map(m => m.id)))
}

// Anchor helpers to preserve reading position across history prepends
function getFirstVisibleMessageEl(container) {
  if (!container) return null
  const items = container.querySelectorAll('.msg-row')
  const cTop = container.getBoundingClientRect().top
  for (const el of items) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > cTop + 4) return el // the first row that crosses the top edge
  }
  return null
}
function captureAnchor(container) {
  const el = getFirstVisibleMessageEl(container)
  if (!container || !el) return { anchorId: null, anchorOffset: 0 }
  const id = Number(el.getAttribute('data-id'))
  const cTop = container.getBoundingClientRect().top
  const offset = el.getBoundingClientRect().top - cTop
  return { anchorId: Number.isFinite(id) ? id : null, anchorOffset: offset }
}
function restoreAnchor(container, anchorId, anchorOffset) {
  if (!container || !anchorId) return false
  const sel = `.msg-row[data-id="${anchorId}"]`
  const el = container.querySelector(sel)
  if (!el) return false
  const cTop = container.getBoundingClientRect().top
  const newOffset = el.getBoundingClientRect().top - cTop
  const delta = newOffset - anchorOffset
  container.scrollTop += delta
  return true
}
// Read current DOM order from the rendered message list
function getDomOrderNumbers() {
  const el = chatPane.value
  if (!el) return []
  const nodes = el.querySelectorAll('.space-y-2 > .flex > div.rounded-lg')
  const arr = []
  nodes.forEach(n => {
    const num = parseInt((n.textContent || '').trim(), 10)
    if (Number.isFinite(num)) arr.push(num)
  })
  return arr
}
function afterDomUpdate() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

const currentChatTitle = computed(() => {
  const item = convList.value.find(c => c.convId === selectedConvId.value)
  return item?.title || 'Chat'
})

async function loadConversations(page, pageSize, space) {
  loadingConvs.value = true
  try {
    convList.value = await chat.listConversations({ page, pageSize, space })
  } finally {
    loadingConvs.value = false
  }
}

function resetMessages() {
  messageIds.value = []
  messageMap.value = new Map()
}

// Sorted-set helpers: maintain messageIds as strictly ascending unique via binary search
function binarySearchAsc(arr, x) {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo // first index >= x
}

function insertIdSortedUnique(id) {
  const ids = messageIds.value
  if (!ids || ids.length === 0) { messageIds.value = [id]; return }
  const pos = binarySearchAsc(ids, id)
  if (pos < ids.length && ids[pos] === id) return // already present
  // create a new array to keep Vue reactivity
  messageIds.value = [...ids.slice(0, pos), id, ...ids.slice(pos)]
}

function mergeMessagesSortedUnique(msgs) {
  if (!Array.isArray(msgs) || !msgs.length) return
  const map = messageMap.value
  for (const m of msgs) {
    // update/insert payload then ensure id is in sorted set
    map.set(m.id, m)
    insertIdSortedUnique(m.id)
  }
}

async function loadLatestMessages(convId, limit, space) {
  if (!convId) return
  loadingMsgs.value = true
  try {
    const msgs = await chat.loadHistory({ convId, limit, space })
    // msgs are ascending by id
    const map = new Map()
    const ids = []
    for (const m of msgs) { map.set(m.id, m); ids.push(m.id) }
    messageMap.value = map
    messageIds.value = ids
    await nextTick()
    const el = chatPane.value
    if (el) el.scrollTop = el.scrollHeight
  } finally {
    loadingMsgs.value = false
  }
}

async function selectConversation(id, space) {
  if (!id) return
  selectedConvId.value = id
  resetMessages()
  await nextTick()
  await loadLatestMessages(id, 20, space)
}

async function onChatScroll(e) {
  const el = e?.target || chatPane.value
  if (!el || loadingMsgs.value) return
  if (el.scrollTop <= 0) {
    await loadMoreHistory(selectedConvId.value, props.space)
  }
}

async function loadMoreHistory(convId, space) {
  if (!convId || loadingMsgs.value) return
  const firstId = messageIds.value[0] ?? 0
  if (firstId <= 1) return
  loadingMsgs.value = true
  try {
    const beforeId = firstId - 1
    const el = chatPane.value
    const oldHeight = el?.scrollHeight || 0
    const oldScrollTop = el?.scrollTop || 0
    // capture anchor before DOM updates
    const { anchorId, anchorOffset } = captureAnchor(el)
    const need = Math.min(20, Math.max(1, beforeId))
    const older = await chat.loadHistory({ convId, limit: need, beforeId, space })
    if (older.length) {
      // merge strictly by id into sorted set (order of input doesn't matter)
      mergeMessagesSortedUnique(older)
      // Force list remount so DOM order strictly follows data order
      listKey.value++
      await nextTick()
      if (el) {
        // Try precise anchor restoration first
        const restored = restoreAnchor(el, anchorId, anchorOffset)
        if (!restored) {
          // Fallback to height delta method
          const newHeight = el.scrollHeight
          const delta = newHeight - oldHeight
          el.scrollTop = oldScrollTop + delta
        }
      }
    }
  } finally {
    loadingMsgs.value = false
  }
}

async function sendMessage(convId, content, space) {
  const text = (content || msgInput.value || '').trim()
  if (!text || !convId) return
  if (content === undefined) msgInput.value = '' // only clear input if using v-model
  await nextTick()
  const msg = await chat.addMessage({ convId, message: { role: 'user', content: text }, space })
  // append new message id at tail
  messageMap.value.set(msg.id, msg)
  insertIdSortedUnique(msg.id)
  await loadConversations(convPage.value, 50, space)
  await nextTick()
  const el = chatPane.value
  if (el) el.scrollTop = el.scrollHeight

  if (autoReply.value) {
    setTimeout(async () => {
      const reply = await chat.addMessage({ convId, message: { role: 'assistant', content: 'Echo: ' + text }, space })
      messageMap.value.set(reply.id, reply)
      insertIdSortedUnique(reply.id)
      await loadConversations(convPage.value, 50, space)
      await nextTick()
      const el2 = chatPane.value
      if (el2) el2.scrollTop = el2.scrollHeight
    }, 500)
  }
}

async function createNewConv(title, space) {
  const conv = await chat.createConversation({ title: title || 'Demo Chat', space })
  await loadConversations(convPage.value, 50, space)
  selectedConvId.value = conv.convId
  await nextTick()
  await loadLatestMessages(conv.convId, 20, space)
}

// Dev: automated order test according to spec
async function runOrderTest() {
  if (testRunning.value) return
  testRunning.value = true
  testLog.value = []
  autoReply.value = false
  try {
    tlog('Preparing test conversations...')
    const primary = await chat.createConversation({ title: 'OrderTest-Primary ' + Date.now(), space: props.space })
    const secondary = await chat.createConversation({ title: 'OrderTest-Secondary ' + Date.now(), space: props.space })

    // Write numbers 1..40 into primary
    tlog('Appending messages 1..40 to Primary')
    for (let i = 1; i <= 40; i++) {
      await chat.addMessage({ convId: primary.convId, message: { role: 'user', content: String(i) }, space: props.space })
    }

    // Switch: go to secondary first
    await selectConversation(secondary.convId, props.space)
    tlog('Switched to Secondary')

    // Enter Primary and check initial window
    await selectConversation(primary.convId, props.space)
    await nextTick()
    await afterDomUpdate()
    const initial = getDomOrderNumbers()
    tlog('Initial (DOM): ' + JSON.stringify(initial))
    // Also log data order for diagnosis
    const initialData = displayedMessages.value.map(m => parseInt(m.content, 10))
    tlog('Initial (Data): ' + JSON.stringify(initialData))
    const expectedInitial = Array.from({ length: 20 }, (_, k) => 21 + k)
    const okInitial = initial.length === 20 && initial.every((v, idx) => v === expectedInitial[idx])

    if (!okInitial) {
      tlog('FAIL: expected [21..40], got ' + JSON.stringify(initial))
    } else {
      tlog('PASS: initial [21..40]')
    }

    // Trigger one history load
    await loadMoreHistory(selectedConvId.value, props.space)
    await nextTick()
    await afterDomUpdate()
    const afterOnce = getDomOrderNumbers()
    tlog('After one loadMore (DOM): ' + JSON.stringify(afterOnce))
    const afterOnceData = displayedMessages.value.map(m => parseInt(m.content, 10))
    tlog('After one loadMore (Data): ' + JSON.stringify(afterOnceData))
    const expectedFull = Array.from({ length: 40 }, (_, k) => 1 + k)
    const okFull = afterOnce.length === 40 && afterOnce.every((v, idx) => v === expectedFull[idx])
    if (!okFull) {
      tlog('FAIL: expected [1..40], got ' + JSON.stringify(afterOnce))
    } else {
      tlog('PASS: full [1..40] after one load')
    }

    if (okInitial && okFull) {
      tlog('ORDER TEST: PASS')
    } else {
      tlog('ORDER TEST: FAIL — please report the arrays above')
    }
  } catch (e) {
    console.error(e)
    tlog('ERROR: ' + (e?.message || e))
  } finally {
    testRunning.value = false
  }
}

onMounted(async () => {
  await loadConversations(convPage.value, 50, props.space)
  if (!convList.value.length) {
    const conv = await chat.createConversation({ title: 'Demo Chat', space: props.space })
    await loadConversations(convPage.value, 50, props.space)
    selectedConvId.value = conv.convId
    await nextTick()
    await loadLatestMessages(conv.convId, 20, props.space)
  } else {
    selectedConvId.value = convList.value[0].convId
    await nextTick()
    await loadLatestMessages(convList.value[0].convId, 20, props.space)
  }
})
</script>

<template lang="pug">
.grid.grid-cols-4.gap-2.min-h-600px
  //- Sidebar - Conversation List
  .bg-stone-50.rounded-lg.border.border-stone-200
    .p-4.border-b.border-stone-200.bg-white.rounded-t-lg.flex.items-center.justify-between
      h3.m-0.font-semibold.text-stone-800 Chats
      button.px-2.py-1.rounded.border.border-stone-300.bg-white.text-stone-700(@click="emit('close')") ← Back
    .p-3.max-h-60svh.overflow-y-auto
      button.px-3.py-2.rounded.bg-blue-600.text-white.w-full.mb-2(@click="createNewConv(undefined, props.space)") ＋ New Conversation
      .space-y-2
        .group.p-3.rounded-lg.border.cursor-pointer.transition-all.hover-shadow-sm(
          v-for="c in convList"
          :key="c.convId"
          @click="selectConversation(c.convId, props.space)"
          :class="selectedConvId === c.convId ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-stone-200 bg-white hover:border-stone-300'"
        )
          .font-medium.truncate(:class="selectedConvId === c.convId ? 'text-blue-700' : 'text-stone-800'") {{ c.title || c.convId }}
          .text-xs.text-stone-500.mt-1 {{ c.lastPreview?.content || 'No messages' }}

  //- Chat Area
  .bg-white.rounded-lg.border.border-stone-200.flex.flex-col.col-span-3
    .p-4.border-b.border-stone-200.flex.items-center.justify-between
      h3.m-0.font-semibold.text-stone-800.truncate {{ currentChatTitle }}
      .flex.items-center.gap-2
        //- Dev test trigger
        button.px-2.py-1.rounded.border.border-amber-300.bg-amber-50.text-amber-700(:disabled="testRunning" @click="runOrderTest") {{ testRunning ? 'Running…' : 'Run Order Test' }}
        button.px-2.py-1.rounded.border.border-stone-300.bg-white.text-stone-700(@click="debugIds = !debugIds") {{ debugIds ? 'Hide Debug' : 'Show Debug' }}
        button.px-2.py-1.rounded.border.border-stone-300.bg-white.text-stone-700(@click="dumpIds") Dump IDs
        label.text-xs.flex.items-center.gap-1
          input(type="checkbox" v-model="autoReply")
          | Auto-reply
    .px-4.pb-2.text-xs.text-stone-500(v-if="testLog.length")
      div.font-medium.mb-1 Test Log:
      pre.max-h-40.overflow-auto.bg-stone-50.p-2.rounded.border.border-stone-200 {{ testLog.join('\n') }}
    .px-4.pb-2.text-xs.text-stone-500(v-if="debugIds")
      div.font-medium.mb-1 Debug IDs:
      div.mb-1
        span.font-mono.mr-1 messageIds:
        span.font-mono {{ messageIds.join(', ') }}
      div
        span.font-mono.mr-1 displayedIds:
        span.font-mono {{ displayedMessages.map(m => m.id).join(', ') }}
    .flex-1.overflow-y-auto.p-4.chat-pane(ref="chatPane" @scroll.passive="onChatScroll")
      .text-center.text-stone-400.text-xs.mb-2(v-if="loadingMsgs") Loading...
      .space-y-2(:key="listKey")
        .flex.msg-row(:data-id="msg.id" v-for="msg in displayedMessages" :key="`${listKey}-${msg.id}`" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'")
          .px-3.py-2.rounded-lg(style="max-width: 75%"
            :class="msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-stone-100 text-stone-800'"
          ) {{ msg.content }}
    .p-3.border-t.border-stone-200.flex.items-center.gap-2
      input.flex-1.px-3.py-2.border.border-stone-300.rounded(type="text" v-model="msgInput" @keydown.enter.prevent="sendMessage(selectedConvId, undefined, props.space)" placeholder="Type a message...")
      button.px-3.py-2.rounded.bg-blue-600.text-white(@click="sendMessage(selectedConvId, undefined, props.space)") Send
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