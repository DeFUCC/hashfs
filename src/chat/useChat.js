import { ref } from 'vue';
import { state, WM, encoder, decoder } from '../useHashFS.js';

export function useChat(options = {}) {
 
  const cfg = { ...options };
  if (!cfg.namespace || typeof cfg.namespace !== 'string') {
    throw new Error('useChat: options.namespace is required');
  }
  if (!Number.isFinite(cfg.chunkSize) || cfg.chunkSize <= 0) {
    throw new Error('useChat: options.chunkSize must be a positive number');
  }

  const initialized = ref(false);

  function ensureAuth() {
    if (!state.auth.value) throw new Error('Not authenticated');
  }

  function cleanPart(p) {
    return String(p || '').replace(/\s+/g, '').replace(/[^a-zA-Z0-9_.\-\/]/g, '');
  }

  function requireSpace(space) {
    if (typeof space !== 'string') {
      throw new Error('space is required for this operation (must be a string, can be empty)');
    }
    return space;
  }

  function root(space) {
    const base = cleanPart(cfg.namespace);
    const seg = cleanPart(requireSpace(space) || '');
    return seg ? `${base}/${seg}` : base;
  }

  function convMetaPath(convId, space) {
    return `${root(space)}/conv/${cleanPart(convId)}/meta.json`;
  }

  function convChunkPath(convId, chunkIdx, space) {
    return `${root(space)}/conv/${cleanPart(convId)}/chunks/${chunkIdx}.ndjson`;
  }

  function seqMaxPath(space) {
    return `${root(space)}/_seq_max.txt`;
  }

  function bySeqPath(seq, space) {
    return `${root(space)}/by-seq/${seq}.json`;
  }

  async function readTextFile(filename) {
    const res = await WM().sendToWorker('load', { filename });
    if (!res || !res.bytes || res.bytes.byteLength === 0) return '';
    return decoder.decode(new Uint8Array(res.bytes));
  }

  async function writeTextFile(filename, text, mime = 'text/plain') {
    const bytes = encoder.encode(String(text));
    await WM().sendToWorker('save', { filename, mime, bytes: bytes.buffer.slice(0, bytes.byteLength) });
  }

  async function readJSON(filename) {
    const txt = await readTextFile(filename);
    if (!txt) return null;
    try { return JSON.parse(txt); } catch { return null; }
  }

  async function writeJSON(filename, obj) {
    const txt = JSON.stringify(obj);
    await writeTextFile(filename, txt, 'application/json');
  }

  async function getSeqMax(space) {
    const txt = await readTextFile(seqMaxPath(space));
    const n = parseInt(txt || '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  async function setSeqMax(val, space) {
    await writeTextFile(seqMaxPath(space), String(val), 'text/plain');
  }

  function nowTs() { return Date.now(); }

  // Create a conversation; returns { convId, title, lastId, updatedAt, seq }
  async function createConversation({ convId = '', title = 'New Chat', space } = {}) {
    ensureAuth();
    const sp = requireSpace(space);

    const id = cleanPart(convId) || `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const meta = {
      convId: id,
      title: String(title || 'New Chat'),
      lastId: 0,
      lastChunkIndex: 0,
      updatedAt: nowTs(),
      lastPreview: null
    };

    await writeJSON(convMetaPath(id, sp), meta);

    // update global sequence index
    const prevSeq = await getSeqMax(sp);
    const seq = prevSeq + 1;
    await setSeqMax(seq, sp);

    const summary = { seq, convId: id, title: meta.title, updatedAt: meta.updatedAt, lastId: meta.lastId, lastPreview: meta.lastPreview };
    await writeJSON(bySeqPath(seq, sp), summary);

    return { ...meta, seq };
  }

  // List conversations by pagination using the global seq index
  // params: { page, pageSize, space }
  async function listConversations({ page, pageSize, space } = {}) {
    ensureAuth();
    if (!Number.isInteger(page) || page < 1) throw new Error('listConversations: page is required and must be a positive integer');
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('listConversations: pageSize is required and must be a positive integer');
    const sp = requireSpace(space);

    const seqMax = await getSeqMax(sp);
    if (seqMax <= 0) return [];

    // scan a bit wider to account for dedupe (heuristic factor 3)
    const scanFactor = 3;
    const startSeq = Math.max(1, seqMax - (page - 1) * pageSize * scanFactor);
    const endSeq = Math.max(1, startSeq - pageSize * scanFactor + 1);

    const items = [];
    const seen = new Set();
    for (let s = startSeq; s >= endSeq && items.length < pageSize; s--) {
      const item = await readJSON(bySeqPath(s, sp));
      if (item && item.convId && !seen.has(item.convId)) {
        items.push(item);
        seen.add(item.convId);
      }
    }

    return items; // deduped, newest first by seq
  }

  // Get preview for a conversation (no message scan)
  async function getConversationPreview(convId, { space } = {}) {
    ensureAuth();
    const sp = requireSpace(space);
    const meta = await readJSON(convMetaPath(convId, sp));
    if (!meta) return null;
    return { convId: meta.convId, title: meta.title, updatedAt: meta.updatedAt, lastId: meta.lastId, lastPreview: meta.lastPreview };
  }

  // Load latest message quickly (reads only the last chunk)
  async function getLatestMessage(convId, { space } = {}) {
    ensureAuth();
    const sp = requireSpace(space);
    const meta = await readJSON(convMetaPath(convId, sp));
    if (!meta || meta.lastId <= 0) return null;

    const chunkIdx = Math.floor((meta.lastId - 1) / cfg.chunkSize);
    const text = await readTextFile(convChunkPath(convId, chunkIdx, sp));
    if (!text) return null;

    const lines = text.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg && msg.id === meta.lastId) return msg;
      } catch { /* ignore */ }
    }
    return null;
  }

  // Load chat history: latest N messages, optionally before a message id
  // params: { convId, limit, beforeId = null, space }
  async function loadHistory({ convId, limit, beforeId = null, space } = {}) {
    ensureAuth();
    if (!Number.isInteger(limit) || limit < 1) throw new Error('loadHistory: limit is required and must be a positive integer');
    const sp = requireSpace(space);

    const meta = await readJSON(convMetaPath(convId, sp));
    if (!meta) return [];

    const boundary = beforeId && beforeId > 0 ? Math.min(beforeId, meta.lastId) : meta.lastId;
    if (!boundary || boundary <= 0) return [];

    const startId = Math.max(1, boundary - limit + 1);
    const startChunk = Math.floor((startId - 1) / cfg.chunkSize);
    const endChunk = Math.floor((boundary - 1) / cfg.chunkSize);

    const messages = [];
    for (let chunk = endChunk; chunk >= startChunk; chunk--) {
      const text = await readTextFile(convChunkPath(convId, chunk, sp));
      if (!text) continue;
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.id >= startId && msg.id <= boundary) {
            messages.push(msg);
            if (messages.length >= limit) break;
          }
        } catch { /* ignore parse error */ }
      }
      if (messages.length >= limit) break;
    }

    // currently in reverse order; return ascending by id
    return messages.sort((a, b) => a.id - b.id);
  }

  // Append a message to conversation with auto-increment id
  // params: { convId, message: { role, content, ... }, space }
  async function addMessage({ convId, message, space } = {}) {
    ensureAuth();
    const sp = requireSpace(space);
    const metaFile = convMetaPath(convId, sp);
    const meta = (await readJSON(metaFile)) || { convId, title: 'Chat', lastId: 0, lastChunkIndex: 0, updatedAt: 0, lastPreview: null };

    const nextId = (meta.lastId || 0) + 1;
    const chunkIdx = Math.floor((nextId - 1) / cfg.chunkSize);

    const msg = {
      id: nextId,
      role: message?.role || 'user',
      content: message?.content ?? '',
      ts: nowTs(),
      ...message
    };

    // append to chunk
    const chunkFile = convChunkPath(convId, chunkIdx, sp);
    const oldText = await readTextFile(chunkFile);
    const newText = (oldText ? (oldText.endsWith('\n') ? oldText : oldText + '\n') : '') + JSON.stringify(msg) + '\n';
    await writeTextFile(chunkFile, newText, 'application/x-ndjson');

    // update meta
    const previewText = String(msg.content || '').slice(0, 120);
    const updatedMeta = {
      ...meta,
      convId,
      lastId: nextId,
      lastChunkIndex: chunkIdx,
      updatedAt: msg.ts,
      lastPreview: { id: nextId, role: msg.role, content: previewText, ts: msg.ts },
    };
    await writeJSON(metaFile, updatedMeta);

    // bump global sequence and write by-seq snapshot
    const prevSeq = await getSeqMax(sp);
    const seq = prevSeq + 1;
    await setSeqMax(seq, sp);
    const summary = { seq, convId, title: updatedMeta.title || 'Chat', updatedAt: updatedMeta.updatedAt, lastId: updatedMeta.lastId, lastPreview: updatedMeta.lastPreview };
    await writeJSON(bySeqPath(seq, sp), summary);

    return msg;
  }

  // Optional helper to set conversation title
  async function setConversationTitle(convId, title, { space } = {}) {
    ensureAuth();
    const sp = requireSpace(space);
    const metaFile = convMetaPath(convId, sp);
    const meta = (await readJSON(metaFile)) || { convId, title: 'Chat', lastId: 0, lastChunkIndex: 0, updatedAt: 0, lastPreview: null };
    meta.title = String(title || 'Chat');
    await writeJSON(metaFile, meta);

    // also reflect in a new seq snapshot for ordering
    const prevSeq = await getSeqMax(sp);
    const seq = prevSeq + 1;
    await setSeqMax(seq, sp);
    const summary = { seq, convId, title: meta.title, updatedAt: meta.updatedAt, lastId: meta.lastId, lastPreview: meta.lastPreview };
    await writeJSON(bySeqPath(seq, sp), summary);

    return true;
  }

  // Lightweight initialization marker (no-op aside from ensuring WM is ready)
  async function init() {
    if (initialized.value) return true;
    // Ensure worker is alive (does not authenticate)
    await WM().initWorker();
    initialized.value = true;
    return true;
  }

  return {
    init,
    createConversation,
    listConversations,
    getConversationPreview,
    getLatestMessage,
    loadHistory,
    addMessage,
    setConversationTitle,
  };
}