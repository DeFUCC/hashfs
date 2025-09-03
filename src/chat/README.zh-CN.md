# 聊天模块（中文）

Language: [English](./README.md) | 中文

该目录包含基于 HashFS 存储实现的聊天组合式 API 与示例界面。

- useChat.js：提供文件存储驱动的聊天 API（会话、消息、分页）
- ChatDemo.vue：一个接近生产实践的聊天 UI，演示历史分页、严格顺序、滚动锚定与发送消息

## 快速开始

从库入口导入组合式 API：

```js
import { useChat } from '../index.js'
```

创建实例（注意：namespace、chunkSize 在创建时传入；space 必须在调用每个 API 时显式传入）：

```js
const chat = useChat({ namespace: 'chat', chunkSize: 200 })
await chat.init()
```

提示：在调用聊天 API 前，应确保已通过 useHashFS 完成鉴权初始化。

### useChat(options) 参数说明
- options.namespace: 必填，字符串。用于隔离聊天数据的命名空间前缀（例如 'chat'）。
- options.chunkSize: 必填，正数。消息分片文件的最大行数（影响历史分页的读取效率）。
- options.space: 不在实例化时使用；每次调用 API 必须显式传入 { space }，支持传入空字符串表示仅使用 namespace 根目录。
- chat.init(): 轻量初始化，确保底层 Worker 可用；不做鉴权，调用各业务方法前需要已完成鉴权。

## API 参考与实用示例

以下 API 默认使用全局顺序索引（seq）保证多会话列表按最新更新时间倒序展示，单会话内消息严格按 id 递增展示。

### 1) createConversation({ convId?, title?, space }) => Promise<Meta>
创建一个新会话，并在全局顺序索引中注册。

参数：
- convId: 可选，字符串。未提供将自动生成（形式如 `c-<timestamp>-<rand>`）。
- title: 可选，字符串。默认 'New Chat'。
- space: 必填，字符串。用于区分业务空间；空字符串表示使用 namespace 根目录。

返回值 Meta：
- convId: 会话 ID
- title: 会话标题
- lastId: 最后一条消息的自增 ID（初始为 0）
- lastChunkIndex: 最后一条消息所在分片索引（初始为 0）
- updatedAt: 最近更新时间（毫秒）
- lastPreview: 最近一条消息的预览 `{ id, role, content, ts }` 或 null
- seq: 全局顺序号（用于会话列表倒序）

可能错误：
- 未鉴权时抛出 `Not authenticated`
- 未传 space 时抛出 `space is required...`

示例：
```js
const { convId } = await chat.createConversation({ title: 'Alice', space: 'myApp' })
```

### 2) listConversations({ page, pageSize, space }) => Promise<Array<Summary>>
分页列出最近会话（按 seq 倒序），按 convId 去重。

参数：
- page: 必填，正整数。页码，从 1 开始。
- pageSize: 必填，正整数。每页条数。
- space: 必填，字符串。业务空间。

返回值：Array<Summary>
- Summary 字段：{ seq, convId, title, updatedAt, lastId, lastPreview }
  - seq: 全局顺序号（越大越新）
  - lastPreview: 最近一条消息的预览 `{ id, role, content, ts }` 或 null

可能错误：
- `page` 或 `pageSize` 非正整数将抛错
- 未鉴权或缺少 space 将抛错

示例：
```js
const convs = await chat.listConversations({ page: 1, pageSize: 20, space: 'myApp' })
```

### 3) getConversationPreview(convId, { space }) => Promise<{ convId, title, updatedAt, lastId, lastPreview } | null>
获取指定会话的最新预览与更新时间（便于渲染会话列表）。

参数：
- convId: 必填，字符串。
- space: 必填，字符串。

返回值：
- 若存在，返回 `{ convId, title, updatedAt, lastId, lastPreview }`
- 若不存在该会话，返回 null

可能错误：
- 未鉴权或缺少 space 将抛错

示例：
```js
const info = await chat.getConversationPreview(convId, { space: 'myApp' })
```

### 4) getLatestMessage(convId, { space }) => Promise<Message | null>
获取某会话最新一条消息。

参数：
- convId: 必填，字符串。
- space: 必填，字符串。

返回值 Message：
- 字段：{ id, role, content, ts, ...自定义扩展 }
  - 注意：消息对象不包含 convId 字段；`ts` 为毫秒时间戳。
- 若会话不存在或无消息，返回 null

可能错误：
- 未鉴权或缺少 space 将抛错

示例：
```js
const latest = await chat.getLatestMessage(convId, { space: 'myApp' })
```

### 5) loadHistory({ convId, beforeId?, limit, space }) => Promise<Array<Message>>
向上分页加载历史消息（返回按 id 升序）。

参数：
- convId: 必填，字符串。
- beforeId: 可选，正整数。若提供，则返回 id ≤ beforeId 的最近若干条；未提供则取最新一页。
- limit: 必填，正整数。返回的最大消息数。
- space: 必填，字符串。

返回值：
- Array<Message>，按 id 升序排列。Message 字段同上 `{ id, role, content, ts, ... }`。

可能错误：
- `limit` 非正整数将抛错
- 未鉴权或缺少 space 将抛错

示例：
```js
const latestPage = await chat.loadHistory({ convId, limit: 20, space: 'myApp' })
const older = await chat.loadHistory({ convId, beforeId: latestPage[0].id - 1, limit: 20, space: 'myApp' })
```

### 6) addMessage({ convId, message, space }) => Promise<Message>
向会话追加一条消息，并更新全局会话顺序（用于会话列表置顶和预览内容）。

参数：
- convId: 必填，字符串。
- message: 必填，对象。
  - role: 可选，字符串，默认 'user'。
  - content: 可选，字符串，默认空串。
  - 其他自定义字段：允许，会被原样存储。
- space: 必填，字符串。

返回值：
- 写入后的 Message 对象，包含自增 `id` 与写入时刻 `ts`。

可能错误：
- 未鉴权或缺少 space 将抛错

示例：
```js
await chat.addMessage({ convId, message: { role: 'user', content: 'Hello' }, space: 'myApp' })
```

### 7) setConversationTitle(convId, title, { space }) => Promise<boolean>
设置会话标题，同时刷新列表展示（写入新的 by-seq 快照）。

参数：
- convId: 必填，字符串。
- title: 必填，字符串。
- space: 必填，字符串。

返回值：
- 成功返回 true。

可能错误：
- 未鉴权或缺少 space 将抛错

示例：
```js
await chat.setConversationTitle(convId, '新的对话标题', { space: 'myApp' })
```

## 端到端示例

```js
import { useChat } from '../index.js'

const chat = useChat({ namespace: 'chat', chunkSize: 200 })
await chat.init()

// 1) 新建会话
const { convId } = await chat.createConversation({ title: 'Alice', space: 'myApp' })

// 2) 发送消息
await chat.addMessage({ convId, message: { role: 'user', content: 'Hello Alice' }, space: 'myApp' })
await chat.addMessage({ convId, message: { role: 'assistant', content: 'Hi! How can I help you?' }, space: 'myApp' })

// 3) 拉取最新一页（升序）
let messages = await chat.loadHistory({ convId, limit: 20, space: 'myApp' })
// 4) 继续向上分页
if (messages[0]?.id > 1) {
  const older = await chat.loadHistory({ convId, beforeId: messages[0].id - 1, limit: 20, space: 'myApp' })
  messages = [...older, ...messages]
}

// 5) 会话列表
const convs = await chat.listConversations({ page: 1, pageSize: 20, space: 'myApp' })
```

## Demo 组件使用提示（ChatDemo.vue）

- 演示了：
  - 历史分页（loadMore）与严格顺序合并
  - 滚动锚定：加载历史时捕获并恢复第一个可见消息的 data-id 与偏移
  - DOM 复用打破：容器 key 与行级 key 结合，确保 DOM 顺序与数据一致
- 如需在你的页面集成 Demo：
  - 从库入口导出：`import { ChatDemo } from '../index.js'`
  - 或直接引用文件：`import ChatDemo from './chat/ChatDemo.vue'`

## 最佳实践建议

- 按需调整每页条数（limit）以匹配视口高度，减少滚动抖动
- 避免连续快速触发多次加载；可在 onScroll 中加入节流/队列化策略
- 发送与加载并发时，使用 id 序号严格合并，避免 DOM 顺序错位
- 出错处理要覆盖：索引损坏、分片丢失、空间切换与权限异常