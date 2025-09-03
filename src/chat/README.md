# Chat Module

 English | [中文](./README.zh-CN.md)
 
 This folder contains the chat composables and demo UI built on top of HashFS storage.
 
 - useChat.js: A Vue composable that provides a file-backed chat API (conversations, messages, pagination) using HashFS + IndexedDB worker.
 - ChatDemo.vue: A simple but production-like chat UI demonstrating typical usage patterns, including history pagination, strict ordering, scroll anchoring, and message sending.
 
 ## Getting Started
 
 Import the composable from the library entry:
 
 ```js
 import { useChat } from '../index.js'
 ```
 
 Create an instance (you MUST pass namespace and chunkSize at creation; space MUST be passed per API call explicitly):
 
 ```js
 const chat = useChat({ namespace: 'chat', chunkSize: 200 })
 await chat.init()
 ```
 
 Note: Make sure you are authenticated with HashFS (useHashFS) before calling any API.

### useChat(options)
- options.namespace: required, string. Namespace prefix to isolate chat data (e.g., 'chat').
- options.chunkSize: required, positive number. Max number of lines per NDJSON chunk file (impacts history read efficiency).
- options.space: not used at instantiation; you MUST pass { space } explicitly on every API call. Passing an empty string means using only the namespace root.
- chat.init(): lightweight initialization; ensures the worker is ready (does not perform authentication).
 
 ## API Reference with Practical Examples
 
 All APIs require you to pass space explicitly on each call.
 
 ### 1) createConversation({ convId?, title?, space }) => Promise<Meta>
 Create a new conversation and register it in the global sequence index.
 
 Parameters:
 - convId: optional, string. If omitted, an id will be generated like `c-<timestamp>-<rand>`.
 - title: optional, string. Default 'New Chat'.
 - space: required, string. Business/tenant space; empty string is allowed to use the namespace root.
 
 Returns Meta:
 - convId: conversation id
 - title: conversation title
 - lastId: latest auto-increment message id (initially 0)
 - lastChunkIndex: index of the last message chunk (initially 0)
 - updatedAt: last updated timestamp (ms)
 - lastPreview: preview of the latest message `{ id, role, content, ts }` or null
 - seq: global sequence number for conversation list ordering (descending, bigger is newer)
 
 Possible errors:
 - Not authenticated
 - Missing space (space must be a string)
 
 Example:
 ```js
 const { convId } = await chat.createConversation({ title: 'Alice', space: 'myApp' })
 ```
 
 ### 2) listConversations({ page, pageSize, space }) => Promise<Array<Summary>>
 List recent conversations using the global seq index (newest first). Deduplicated by convId.
 
 Parameters:
 - page: required, positive integer. Page number starting from 1.
 - pageSize: required, positive integer. Page size.
 - space: required, string. Business/tenant space.
 
 Returns Array<Summary> where each Summary is:
 - { seq, convId, title, updatedAt, lastId, lastPreview }
   - seq: global sequence number (larger is newer)
   - lastPreview: `{ id, role, content, ts }` or null
 
 Possible errors:
 - page or pageSize is not a positive integer
 - Not authenticated or missing space
 
 Example:
 ```js
 const list = await chat.listConversations({ page: 1, pageSize: 20, space: 'myApp' })
 ```
 
 ### 3) getConversationPreview(convId, { space }) => Promise<{ convId, title, updatedAt, lastId, lastPreview } | null>
 Fetch the latest preview for a conversation without loading messages.
 
 Parameters:
 - convId: required, string.
 - space: required, string.
 
 Returns:
 - If the conversation exists: `{ convId, title, updatedAt, lastId, lastPreview }`
 - If it does not exist: null
 
 Possible errors:
 - Not authenticated or missing space
 
 Example:
 ```js
 const info = await chat.getConversationPreview(convId, { space: 'myApp' })
 ```
 
 ### 4) getLatestMessage(convId, { space }) => Promise<Message | null>
 Fast path to retrieve the latest message of a conversation.
 
 Parameters:
 - convId: required, string.
 - space: required, string.
 
 Returns Message:
 - Fields: { id, role, content, ts, ...custom }
   - Note: Message object does not include convId; ts is a millisecond timestamp.
 - Returns null if the conversation does not exist or has no messages.
 
 Possible errors:
 - Not authenticated or missing space
 
 Example:
 ```js
 const latest = await chat.getLatestMessage(convId, { space: 'myApp' })
 ```
 
 ### 5) loadHistory({ convId, beforeId?, limit, space }) => Promise<Array<Message>>
 Load history in ascending order by id; optionally before a given message id.
 
 Parameters:
 - convId: required, string.
 - beforeId: optional, positive integer. If provided, returns messages with id ≤ beforeId; otherwise returns the latest window.
 - limit: required, positive integer. Max number of messages to return.
 - space: required, string.
 
 Returns:
 - Array<Message> sorted ascending by id. Message has the same fields as above `{ id, role, content, ts, ... }`.
 
 Possible errors:
 - limit is not a positive integer
 - Not authenticated or missing space
 
 Example:
 ```js
 const latestPage = await chat.loadHistory({ convId, limit: 20, space: 'myApp' })
 const older = await chat.loadHistory({ convId, beforeId: latestPage[0].id - 1, limit: 20, space: 'myApp' })
 ```
 
 ### 6) addMessage({ convId, message, space }) => Promise<Message>
 Append a message and bump the global sequence snapshot (so the conversation moves to the top and preview updates).
 
 Parameters:
 - convId: required, string.
 - message: required, object.
   - role: optional, string, default 'user'.
   - content: optional, string, default ''.
   - other custom fields are allowed and will be stored as-is.
 - space: required, string.
 
 Returns:
 - The stored Message including assigned auto-increment id and write timestamp ts.
 
 Possible errors:
 - Not authenticated or missing space
 
 Example:
 ```js
 const msg = await chat.addMessage({ convId, message: { role: 'user', content: 'Hello!' }, space: 'myApp' })
 ```
 
 ### 7) setConversationTitle(convId, title, { space }) => Promise<boolean>
 Rename a conversation and write a new seq snapshot for list ordering.
 
 Parameters:
 - convId: required, string.
 - title: required, string.
 - space: required, string.
 
 Returns:
 - true on success.
 
 Possible errors:
 - Not authenticated or missing space
 
 Example:
 ```js
 await chat.setConversationTitle(convId, 'Project X', { space: 'myApp' })
 ```
 
 ## End-to-End Example
 
 ```js
 import { useChat } from '../index.js'
 
 const chat = useChat({ namespace: 'chat', chunkSize: 200 })
 await chat.init()
 
 // ensure a conversation
 const { convId } = await chat.createConversation({ title: 'Support', space: 'prod' })
 
 // initial window
 let messages = await chat.loadHistory({ convId, limit: 30, space: 'prod' })
 
 // prepend older when scrolled to top
 const firstId = messages[0]?.id
 if (firstId > 1) {
   const older = await chat.loadHistory({ convId, limit: 30, beforeId: firstId - 1, space: 'prod' })
   messages = [...older, ...messages] // messages stay sorted ascending
 }
 
 // send a message
 await chat.addMessage({ convId, message: { role: 'user', content: 'Hi there' }, space: 'prod' })
 ```
 
 ## Demo UI Tips (ChatDemo.vue)
 - Keeps internal ids strictly ascending and unique when merging.
 - Forces DOM remount on history prepend to avoid node reuse.
 - Precise scroll anchoring: captures first visible row and restores its visual offset after merge.
 - Includes a test harness to verify ordering and debug id sequences.
 
 Feel free to copy parts of ChatDemo.vue into your own app.