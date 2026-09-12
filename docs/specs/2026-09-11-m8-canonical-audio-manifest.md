# M8 — Canonical Audio 与 Story Audio Manifest 技术方案

**所属 Phase**：P3
**前置模块**：M2 StoryWork、M5 Playback Session
**直接消费者**：M5 PlaybackSessionFlow、M7 Expanded Now Playing、M2 Library audio projection
**核心目标**：把当前“每次播放重新 TTS + 临时 Blob URL”的 Work 播放方式，演进为可持久化、可复用、音色稳定的 Canonical Audio。

---

# 0. 核心技术决策

| 决策                       | 推荐                                                      |
| ------------------------ | ------------------------------------------------------- |
| Canonical Audio 存储       | **私有 S3-compatible Object Storage**                     |
| 本地部署支持                   | 提供 Local Filesystem backend                             |
| 是否做 Local + Object 双层热缓存 | **否，M8 不做**                                             |
| DB 是否保存音频二进制             | **绝不保存**                                                |
| DB 保存内容                  | Manifest / Segment metadata / storage key               |
| Canonical 单位             | **Story Segment，而不是整篇单文件**                              |
| Segment 边界               | 冻结 `segmentStoryText` 结果                                |
| Segment 文本是否持久化          | **是**                                                   |
| Work identity            | 继续使用 M2 `StoryWork.id`                                  |
| Playback Session         | 完全沿用 M5，不改变                                             |
| Canonical TTS speed      | **固定 1.0x**                                             |
| 用户倍速                     | `<audio>.playbackRate`                                  |
| 首次迁移                     | **Lazy per-segment materialization**                    |
| 完整音频 ready               | 所有 Segment 均 canonicalized 后                            |
| Storage key              | Opaque UUID，不编码 user/work identity                      |
| 浏览器是否知道 object key       | **否**                                                   |
| Bucket                   | private                                                 |
| 音频访问                     | App route → local Range stream / object signed redirect |
| 删除                       | DB tombstone + 异步/机会式 object cleanup                    |
| Trash                    | 30 天内保留音频                                               |
| Guest 注册                 | 转移 Manifest ownership，不复制音频 bytes                       |

---

# 1. 当前链路

当前正式 TTS 路径：

```text
Client
  ↓
trpc.tts.synthesize
  ↓
lib/server/openai.ts
  ↓
OpenAI audio.speech.create
  ↓
ArrayBuffer
  ↓
base64
  ↓
浏览器
  ↓
Blob
  ↓
URL.createObjectURL()
  ↓
AudioControllerHost
```

`tts.synthesize` 当前返回 `audioBase64 + contentType`；`fetchAudio()` 再将 base64 转成浏览器 Blob URL。

Story paragraph replay 也是：

```text
storyText
  ↓
segmentStoryText
  ↓
fetchAudio(paragraph)
  ↓
临时 Blob URL
```

代码已经明确注明：

> 音频为临时 Blob URL，因此历史和恢复播放需要重新 TTS。

现有分段算法是稳定确定性的 `SEGMENTATION_VERSION = v1`，目标约 160 字、最大约 350 字，并具有规范化与长段拆分逻辑。

M8 不推翻这个 paragraph playback 模型，而是在它下面增加：

```text
Segment Text
    ↓
Canonical Segment Asset
```

---

# 2. 存储选型

这是 M8 最重要的架构决定。

当前部署为单个 Docker `web` 服务：

```text
web
└── DATABASE_URL=file:/app/data/app.db

./data → /app/data
```

Dockerfile 也只声明了 `/app/data` 持久目录。

---

# 2.1 方案 A — 本地持久卷

例如：

```text
./audio → /app/audio
```

结构：

```text
Host
├── ./data/app.db
└── ./audio/*.mp3
```

### 优点

* 几乎零新增基础设施；
* 无 object API request / egress 成本；
* 单机读取速度好；
* 最容易实现和调试；
* 很适合个人、自托管、小流量部署。

### 缺点

音频从数据库 KB 级数据变成持续增长的 MB/GB 级资产以后：

* 宿主机磁盘成为容量上限；
* 单机故障同时影响应用和全部音频；
* 扩容/迁机需要搬整个音频目录；
* 多实例无法共享资产；
* 备份复杂度明显提高；
* CDN / 跨地域能力弱；
* 容器部署必须严格保护 volume。

如果把音频直接放：

```text
/app/data/audio
```

还会导致：

> DB backup 和 Audio backup 被强制耦合。

因此即便选择 Local，也推荐：

```text
/app/data  → SQLite
/app/audio → Audio
```

两个独立 volume。

---

# 2.2 方案 B — S3-compatible Object Storage

Canonical bytes：

```text
Private Object Bucket
```

SQLite 只保存：

```text
storageKey
byteLength
duration
checksum
metadata
```

### 优点

* 音频生命周期与单机 Docker 解耦；
* App 容器无状态程度提高；
* 不占应用服务器磁盘；
* 天然适合大量 immutable blob；
* Range request、CDN、签名 URL 能力成熟；
* 后续迁机/扩容无需搬音频；
* SQLite → 其他数据库的未来迁移不会与音频资产绑定；
* Audio backup / lifecycle 可以单独治理。

### 成本

会增加：

* 对象存储容量费用；
* PUT / GET 请求费用；
* 某些服务的公网流量费用；
* 一个 bucket 和 credentials 的运维；
* SDK 依赖。

但 StoryWork 未来真正增长后：

> 音频存储成本会远高于 SQLite metadata。

越晚拆，迁移成本越高。

---

# 2.3 方案 C — Object Canonical + Local Hot Cache

```text
Object Storage
      +
Local Audio Cache
```

优点：

* 热音频本地读取；
* 降低部分远端流量。

缺点：

需要增加：

```text
cache key
cache eviction
disk quota
双源一致性
cache invalidation
orphan cleanup
```

对于当前单实例规模收益很低。

### 推荐

**M8 不做 Hybrid Hot Cache。**

---

# 2.4 最终推荐

生产：

```text
Canonical Source of Truth
        =
S3-compatible Object Storage
```

开发 / 本地自托管：

```text
AudioAssetStorage
        ↓
LocalFilesystemStorage
```

两个 backend 共用同一个业务接口：

```ts
interface AudioAssetStorage {
  put(...)
  stat(...)
  delete(...)
  resolveRead(...)
}
```

不是：

```text
生产同时写 local + S3
```

而是：

```text
同一代码
按配置选择一个 canonical backend
```

### 为什么当前还是推荐 Object Storage

虽然 DB 目前仍是单机 SQLite，但：

> SQLite metadata 很小，音频 bytes 才是未来真正的容量主体。

把大 Blob 从 App Host 解耦，比现在立刻更换数据库更有价值。

---

# 3. Storage 配置

建议新增：

```text
AUDIO_STORAGE_DRIVER=s3 | local
```

Local：

```text
AUDIO_LOCAL_ROOT=/app/audio
```

S3：

```text
AUDIO_S3_ENDPOINT=
AUDIO_S3_REGION=
AUDIO_S3_BUCKET=
AUDIO_S3_ACCESS_KEY_ID=
AUDIO_S3_SECRET_ACCESS_KEY=
AUDIO_S3_FORCE_PATH_STYLE=false
AUDIO_SIGNED_URL_TTL_SECONDS=900
```

Bucket：

```text
private
```

禁止公开 ACL。

---

# 3.1 Docker

Local backend 时：

```yaml
volumes:
  - ./data:/app/data
  - ./audio:/app/audio
```

不要放：

```text
./data/audio
```

以便数据库和音频：

* 独立备份；
* 独立容量；
* 独立迁移。

---

# 4. Storage abstraction

新增：

```text
lib/audio/storage/
├── types.ts
├── index.ts
├── local.ts
└── s3.ts
```

核心：

```ts
type PutAudioObjectInput = {
  key: string
  bytes: Uint8Array
  contentType: string
}

interface AudioAssetStorage {
  put(input: PutAudioObjectInput): Promise<void>

  exists(key: string): Promise<boolean>

  delete(key: string): Promise<void>

  getMetadata(key: string): Promise<{
    size: number
    contentType: string
  } | null>

  resolveRead(
    key: string,
    range?: string
  ): Promise<AudioStorageReadResult>
}
```

客户端永远不知道实际：

```text
bucket
filesystem path
storageKey
```

---

# 5. Audio Manifest 数据模型

M8 建议继续遵循 User / Guest 物理隔离。

新增：

```text
StoryAudioManifest
StoryAudioSegment

GuestStoryAudioManifest
GuestStoryAudioSegment
```

---

# 5.1 StoryAudioManifest

推荐模型：

```prisma
model StoryAudioManifest {
  id          Int       @id @default(autoincrement())

  storyWorkId Int
  storyWork   StoryWork @relation(
    fields: [storyWorkId],
    references: [id],
    onDelete: Cascade
  )

  version Int @default(1)

  status String @default("missing")

  contentHash         String
  segmentationVersion String

  voiceId String

  ttsBackendId String
  ttsModel     String

  synthesisVersion String
  synthesisSpeed   Float  @default(1.0)
  audioFormat      String @default("mp3")

  segmentCount      Int
  readySegmentCount Int @default(0)

  totalDurationMs Int?
  totalByteLength Int?

  lastErrorCode String?

  readyAt      DateTime?
  supersededAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  segments StoryAudioSegment[]

  @@unique([storyWorkId, version])
  @@index([storyWorkId, status])
  @@index([status, updatedAt])
}
```

Guest 对称。

---

# 5.2 Manifest identity

Manifest 冻结：

```text
StoryWork.contentHash
+
segmentationVersion
+
voiceId
+
ttsBackendId
+
ttsModel
+
synthesisVersion
+
audioFormat
+
canonicalSpeed=1.0
```

它回答：

> “这一组 Segment Audio 是依据什么正文、什么切段方式、什么声音参数生成的？”

---

# 5.3 为什么需要 ttsBackendId

当前项目允许自定义：

```text
OPENAI_BASE_URL
```

同样：

```text
model = tts-1
```

可能对应不同 OpenAI-compatible backend。

因此只保存：

```text
ttsModel = "tts-1"
```

不足以表达真实 synthesis identity。

建议新增显式配置：

```text
TTS_BACKEND_ID=openai
```

例如：

```text
openai
company-proxy-v1
internal-tts-cn
```

它不是 secret，只是稳定 identity。

---

# 5.4 synthesisVersion

应用自己定义：

```text
canonical-mp3-v1
```

当这些语义变化时 bump：

* 请求 format；
* normalization；
* canonical speed；
* post processing；
* loudness；
* encoder；
* TTS request semantics。

它不是 Provider model version。

---

# 6. Segment 模型

```prisma
model StoryAudioSegment {
  id String @id

  manifestId Int
  manifest   StoryAudioManifest
    @relation(fields: [manifestId], references: [id], onDelete: Cascade)

  segmentIndex Int

  text     String
  textHash String

  status String @default("missing")

  storageKey String @unique

  contentType String @default("audio/mpeg")
  byteLength  Int?
  durationMs  Int?

  audioChecksum String?

  leaseId        String?
  leaseExpiresAt DateTime?

  attemptCount  Int @default(0)
  lastErrorCode String?

  readyAt   DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([manifestId, segmentIndex])
  @@index([manifestId, status])
  @@index([leaseExpiresAt])
}
```

Guest 对称。

---

# 6.1 Segment ID

使用：

```ts
crypto.randomUUID()
```

Service 显式生成。

不要：

```text
userId/workId/segmentIndex
```

作为公开 ID。

---

# 6.2 Storage key

推荐：

```text
story-audio/<segment-uuid>.mp3
```

例如：

```text
story-audio/
  4f5bb34a-...-74af.mp3
```

DB 保存：

```text
storageKey
```

浏览器不获取。

---

# 6.3 为什么 key 不包含 StoryWork ID / User ID

主要是 Guest 注册。

M2/M5 已经确认：

```text
Guest Work 35
   ↓ register
User Work 481
```

如果 Object Key 是：

```text
guest/abc/work/35/...
```

注册以后就必须：

* copy；
* rename；
* 或长期保留错误 ownership path。

Opaque asset key 可以让：

```text
DB ownership 变化
```

而：

```text
Object bytes 完全不动
```

这是更干净的边界。

---

# 6.4 为什么 Segment 必须保存 text

不能只保存：

```text
segmentIndex
textHash
```

因为未来：

```text
SEGMENTATION_VERSION v1 → v2
```

以后，如果一个旧 Manifest 只有第 1～5 段完成，但第 6 段还没有生成：

> 当前 `segmentStoryText()` 已经可能无法重新得到旧 v1 的第 6 段。

所以 Manifest 创建时必须冻结：

```text
segment.text
segment.textHash
```

之后无论主代码切段算法如何变化，都可以继续完成原 Manifest。

---

# 6.5 textHash

直接复用已锁定的：

```text
computeStoryContentHash(segment.text)
```

不新造另一套正文 Hash。

Story 级：

```text
StoryWork.contentHash
```

Segment 级：

```text
computeStoryContentHash(segmentText)
```

---

# 6.6 audioChecksum

这是另一种用途。

推荐：

```text
SHA-256(audio bytes)
```

这里使用 cryptographic SHA-256 是合理的，因为它表示：

> Blob integrity

而不是 Story content identity。

必须明确区分：

```text
contentHash
≠
audioChecksum
```

---

# 7. Canonical speed

当前链路中：

```text
fetchAudio(text, voiceId, speed)
```

会把 speed 发送给 TTS Provider；同时 `AudioControllerHost` 又设置：

```text
audioEl.playbackRate = playbackRate
```

对于 Canonical Asset 不能继续这样。

---

## 推荐

Canonical synthesis：

```text
speed = 1.0
```

唯一持久化一份。

用户：

```text
0.8x
1.0x
1.25x
1.5x
2.0x
```

全部由：

```text
HTMLAudioElement.playbackRate
```

实现。

这样：

```text
1 Work
+
1 Voice
=
1 Canonical Audio
```

而不是：

```text
1 Work × N playback speeds
```

---

# 7.1 speed 不进入 asset cache key

以下变化：

```text
1.0x → 1.5x
```

不会：

* 创建新 Manifest；
* 重新 TTS；
* 改 contentHash；
* 改 duration metadata。

M7 展示出来的：

```text
原始作品时长
```

仍基于 1.0x duration。

实际剩余播放时间可按 playbackRate 动态算。

---

# 8. Voice binding

Manifest 创建时：

```text
StoryWork.voiceId
```

优先。

Legacy：

```text
voiceId == ""
```

则：

```text
resolve current configured default voice
```

并立即：

1. 写 Manifest.voiceId；
2. 推荐同时 backfill StoryWork.voiceId。

这样第一次 canonicalization 后：

> 该作品声音身份正式冻结。

以后用户修改全局默认 Voice 不影响它。

---

# 9. Model binding

当前 `OPENAI_TTS_MODEL` 默认为：

```text
tts-1
```

且 `synthesizeSpeech()` 每次读取配置模型。

Canonical Manifest 创建以后：

```text
manifest.ttsModel
```

必须成为后续缺失 Segment 的 authoritative model。

即使部署环境后来改成：

```text
OPENAI_TTS_MODEL=new-model
```

旧 Manifest 的第 8 段仍然请求：

```text
old manifest model
```

因此需要把当前函数演进为：

```ts
synthesizeSpeechWithProfile({
  text,
  model,
  voiceId,
  speed,
  format,
})
```

旧：

```ts
synthesizeSpeech(text, voiceId, speed)
```

继续作为 Draft compatibility wrapper。

---

# 9.1 Provider 不可变性的现实边界

即使 Manifest 保存：

```text
model="tts-1"
```

Provider 也可能在后台改变 alias 指向的实现。

系统无法从 API 得到真实不可变 revision 时，不能保证：

> 两个月以后补生成的 Segment 和两个月前 acoustic output 完全相同。

因此：

### 推荐

如果 Provider 提供 versioned model：

```text
优先配置 versioned model
```

否则：

```text
Manifest 只能保证 request profile 一致
```

已经保存的 Segment bytes 则永远保持不变。

---

# 10. Manifest 创建

第一次对一个 Work 请求 canonical audio：

```text
ensureSegment(workId, index)
```

如果不存在 active Manifest：

1. 读取 StoryWork；
2. 验证 active；
3. `normalizeStoryText()`；
4. 校验 `contentHash`；
5. 使用当前 `segmentStoryText()`；
6. resolve voice；
7. freeze TTS profile；
8. 创建 Manifest；
9. 为所有 segment 创建 DB rows。

此阶段：

```text
不调用 TTS
```

因此创建 Manifest 成本很低。

---

# 11. Manifest version

V1 StoryWork 内容不可直接修改，因此正常情况下：

```text
version = 1
```

仍然保留 version，是为了以后支持：

* Revoice；
* TTS migration；
* Audio regeneration；
* synthesis algorithm upgrade。

未来：

```text
manifest v1
→ supersededAt

manifest v2
→ active
```

M8 当前不提供用户侧“重生成全部音频”。

---

# 12. audioStatus 状态机

对 M2 预留：

```ts
audio: {
  status: 'missing' | 'preparing' | 'ready' | 'failed'
  durationMs: number | null
}
```

M8 正式填充。

---

# 12.1 Segment 状态

```text
missing
   ↓
preparing
   ↓
ready
```

失败：

```text
preparing
   ↓
failed
   ↓ retry
preparing
```

---

# 12.2 Manifest 状态

使用同四态：

```text
missing
preparing
ready
failed
```

定义：

### missing

* 没有 Manifest；

或：

* Manifest 只有部分 Segment ready；
* 当前没有 synthesis 在执行。

### preparing

至少有一个 canonical Segment：

```text
lease active
```

### ready

```text
readySegmentCount == segmentCount
```

且：

```text
所有 durationMs != null
```

### failed

最近一次用户需要的 Segment 准备失败，且当前没有 active synthesis。

---

# 12.3 为什么 partial 不增加第五个状态

产品层目前只需要：

```text
missing / preparing / ready / failed
```

Partial Segment 是内部实现。

Library 不需要告诉用户：

```text
7 / 12 segments 已缓存
```

---

# 12.4 Projection

M2：

```text
library.list
library.get
```

通过 M8 service enrichment 得到：

```ts
audio: {
  status: manifestStatus,
  durationMs:
    status === 'ready'
      ? totalDurationMs
      : null
}
```

### UI 推荐

`missing`：

> 不显示错误 Badge。

用户点击播放即可 lazy prepare。

`preparing`：

> 正在准备语音

`ready`：

> 正常显示 duration。

`failed`：

> 语音准备失败 / 重试。

---

# 13. Lazy migration

旧 StoryWork：

```text
没有 Manifest
```

不进行批量 TTS。

否则一上线就可能：

> 对现存所有故事产生大规模 TTS 成本。

---

# 13.1 第一次播放

```text
M5 begin Work
    ↓
M8 resolve segment 0
    ↓
Manifest 不存在
    ↓
创建 Manifest + frozen Segment rows
    ↓
Segment 0 synthesis
    ↓
Store object
    ↓
播放
```

---

# 13.2 下一段

M5 现有 lookahead = 1 行为可以自然变成：

```text
当前播放 Segment N
       ↓ near end
ensure Segment N+1
       ↓
already ready ?
 ├── yes → 直接使用
 └── no  → synthesize + persist
```

当前 paragraph playback 已经严格限制只预取下一段，因此非常适合直接替换底层音频来源。

---

# 13.3 用户听完整篇

自然形成：

```text
segment 0 ready
segment 1 ready
...
segment N ready

Manifest → ready
```

无需单独 Build Job。

---

# 13.4 用户听到一半离开

例如：

```text
5 / 12 ready
```

Manifest：

```text
missing
```

已有 5 段长期保存。

下次 Resume：

```text
第 5 段 ready → 秒开
第 6 段 missing → 按需生成
```

---

# 14. 为什么不首次播放就生成整篇

StoryWork 最大 20,000 chars，而当前 segment 最大约 350 chars，长作品可以产生大量 TTS request。

首次点击播放如果要求：

```text
全部段落生成完成
```

才开始播放，会带来：

* 首播等待巨大；
* TTS burst；
* Provider rate limit；
* 大量用户根本不会听到的浪费资产。

因此明确推荐：

> **Segment-level lazy materialization + lookahead 1。**

---

# 15. Segment synthesis concurrency

必须防止：

```text
Tab A
Tab B
同一 Work
同时请求 Segment 4
```

造成两次 TTS。

---

# 15.1 Lease

Segment 保存：

```text
leaseId
leaseExpiresAt
```

流程：

```text
ensureSegment
      ↓
ready ?
 └ yes → return
      ↓
try claim lease
```

成功：

```text
status = preparing
leaseId = UUID
leaseExpiresAt = now + lease TTL
attemptCount += 1
```

然后在 DB transaction 外调用 TTS。

---

# 15.2 为什么不能持有 SQLite transaction 等 TTS

TTS 属于外部网络调用，可能数秒。

如果：

```text
BEGIN TRANSACTION
→ TTS
→ COMMIT
```

会长时间持有 SQLite write lock。

因此绝对禁止。

---

# 15.3 Race

如果另一个请求已经持有有效 Lease：

返回：

```ts
{
  status: 'preparing'
  retryAfterMs: 500
}
```

Client/M5 retry。

不重复调用 TTS。

---

# 15.4 Lease expiry

Node crash：

```text
status = preparing
lease expired
```

下一次请求：

```text
重新 claim
```

恢复。

---

# 16. Synthesis pipeline

Canonical Work path：

```text
StoryWork
   ↓
Manifest Segment Text
   ↓
synthesizeSpeechWithProfile()
   ↓
ArrayBuffer
   ↓
MP3 metadata
   ↓
duration
   ↓
checksum
   ↓
AudioAssetStorage.put()
   ↓
Segment READY
   ↓
Manifest counters/status
```

整个过程不再经过：

```text
base64 → Browser → Blob
```

因此 Canonical persistence 不增加约 4/3 的 base64 transport overhead。

---

# 17. Duration

Canonical timeline 必须有可信：

```text
durationMs
```

不能等浏览器第一次播放以后再写 DB。

推荐 server-side 解析生成后的 MP3。

不建议加入：

```text
ffmpeg / ffprobe
```

因为当前 Docker 是轻量 Node 22 Alpine，增加系统二进制会显著增加镜像和维护复杂度。

推荐引入纯 Node MP3 metadata parser。

首选：

```text
music-metadata
```

落地时锁版本。

流程：

```text
ArrayBuffer
  ↓
Buffer
  ↓
parseBuffer()
  ↓
duration
```

---

# 17.1 Manifest total duration

只有：

```text
所有 segments ready
```

才写：

```text
totalDurationMs =
sum(segment.durationMs)
```

M7 才能从这里建立稳定：

```text
Story-level timeline
```

---

# 18. Storage object write

推荐顺序：

```text
1 DB 已存在 Segment row + stable storageKey
2 synthesize bytes
3 calculate duration/checksum
4 storage.put(storageKey)
5 DB UPDATE segment ready
```

不能反过来先生成随机 storage object 再建 DB row。

因为 crash 时更容易产生不可追踪 orphan。

---

# 18.1 DB update 失败

如果：

```text
storage.put success
DB ready update failed
```

下次 retry：

* 使用相同 storageKey；
* overwrite 同一 object；
* 不生成第二个 orphan key。

---

# 19. Audio Access

浏览器不直接获取：

```text
s3://...
storageKey
```

统一使用：

```text
GET /api/audio/segments/:segmentId
```

---

# 19.1 Ownership

Route：

1. resolve Subject；
2. 查询 Segment；
3. 沿 Manifest → StoryWork 验证 ownership；
4. 允许读取。

Trash Work：

> 可以读已有 asset。

这是为了保持 M5 已拍板：

> 当前正在播放的作品移入 Trash 后，当前内存 Session 可以继续。

Permanent delete 后 Segment row 不存在：

```text
404
```

---

# 19.2 Local backend

Route 直接 stream。

必须支持：

```text
Range
```

返回：

```text
206 Partial Content
Accept-Ranges: bytes
Content-Range
Content-Length
Content-Type: audio/mpeg
```

否则 M7 seek 在远程 asset 上体验会退化。

---

# 19.3 Object backend

App route：

```text
验证 ownership
      ↓
生成短时 signed GET URL
      ↓
307 redirect
```

浏览器：

```text
direct → Object Storage
```

App Node 不代理实际音频流量。

优点：

* 不占 Node bandwidth；
* Object Storage 原生 Range；
* URL 短期有效；
* bucket 仍为 private。

---

# 20. API 契约

新增：

```text
storyAudio router
```

而不是把资产管理继续塞入通用：

```text
tts router
```

---

# 20.1 getPlaybackManifest

```text
storyAudio.getPlaybackManifest
```

Input：

```ts
{
  workId: number
}
```

Output：

```ts
type StoryAudioManifestDTO = {
  workId: number

  status:
    | 'missing'
    | 'preparing'
    | 'ready'
    | 'failed'

  contentHash: string

  segmentationVersion: string

  voiceId: string

  segmentCount: number
  readySegmentCount: number

  totalDurationMs: number | null

  segments: Array<{
    index: number

    text: string
    textHash: string

    status:
      | 'missing'
      | 'preparing'
      | 'ready'
      | 'failed'

    durationMs: number | null

    playbackUrl: string | null
  }>
}
```

`playbackUrl`：

```text
/api/audio/segments/<opaque-id>
```

只对 ready Segment 返回。

---

# 20.2 ensureSegment

```text
storyAudio.ensureSegment
```

Input：

```ts
{
  workId: number
  segmentIndex: number

  sessionId: string
}
```

为什么带 `sessionId`：

* 与 M5 stale protection 配合；
* Trash 后只允许当前合法 Session 继续创建缺失 Segment。

---

## Output — ready

```ts
{
  status: 'ready'

  segment: {
    index: number
    text: string
    durationMs: number
    playbackUrl: string
  }

  manifest: {
    status: AudioStatus
    readySegmentCount: number
    segmentCount: number
    totalDurationMs: number | null
  }
}
```

---

## Output — preparing

```ts
{
  status: 'preparing'
  retryAfterMs: 500
}
```

---

## Error

稳定 domain code：

```text
WORK_NOT_FOUND
WORK_UNAVAILABLE
INVALID_SEGMENT
AUDIO_SYNTHESIS_FAILED
AUDIO_STORAGE_FAILED
AUDIO_PROFILE_UNAVAILABLE
```

不要把 Provider 原始 error message 直接暴露客户端。

---

# 21. Active / Trash 权限

Active Work：

```text
当前 Subject
→ ensureSegment allowed
```

Trash Work：

```text
如果 current M5 Anchor:
workId matches
AND sessionId matches
→ allowed
```

否则：

```text
WORK_UNAVAILABLE
```

这样符合 M5-P03：

> 老 Session 可继续，但不能在 Trash Work 上开始新的播放。

---

# 22. M5 集成

M8 不改变：

```text
PlaybackSourceRef
Playback Session
StoryWork identity
UUID session
Progress
Anchor
```

只把：

```text
“这个 paragraph 的 audioUrl 从哪里来”
```

替换掉。

---

# 22.1 M5 Before

```text
paragraph text
    ↓
fetchAudio()
    ↓
Blob URL
```

---

# 22.2 M5 After — Work

```text
workId + segmentIndex + sessionId
          ↓
storyAudio.ensureSegment()
          ↓
Canonical playback URL
```

---

# 22.3 Draft

Draft 继续：

```text
tts.synthesize
→ ephemeral audio
```

因为：

* Draft 尚未是稳定资产；
* 不值得做持久化；
* 可能被继续修改或丢弃。

---

# 22.4 Draft → Work

Promotion 后：

```text
后续 Segment
→ Canonical path
```

已经在播放的当前 Draft Blob：

> 不强制停止、不重新 TTS。

这一段第一次未来重播时再 Canonicalize。

这样避免 M4 Promotion 造成音频中断。

---

# 23. Manifest segmentation 与 M5

M5 当前：

```text
StoryWork.storyText
→ current segmentStoryText()
```

M8 上线后：

### 没有 Manifest

继续当前行为。

### 存在 Manifest

Work playback 优先使用：

```text
Manifest.segments[].text
Manifest.segmentationVersion
```

而不是重新用未来版本算法切分。

这样：

```text
Audio segment index
=
Playback progress index
```

永久保持一致。

这不改变 M5 identity，仅改变 Work 的 segment provider。

---

# 24. Library projection

M2 原先预留：

```ts
audio: null | {
  status: ...
  durationMs: number | null
}
```

M8 后：

```text
null
```

不再使用。

统一始终返回：

```ts
audio: {
  status: 'missing',
  durationMs: null,
}
```

即使没有 Manifest。

理由：

M3 不应该处理：

```text
null
vs missing
```

两个等价状态。

---

# 25. 原 `tts.synthesize`

保留。

当前 API：

```text
tts.synthesize({
  text,
  voiceId,
  speed
})
```

仍服务：

* Draft；
* legacy compatibility；
* 非 StoryWork 瞬态播放。

M8 不把它改造成“上传 Story audio”的通用入口。

---

# 26. 防止客户端伪造 Canonical Audio

禁止 API：

```text
POST /storyAudio
{
  workId,
  text: "...",
  audioBytes: "..."
}
```

Canonical input 必须全部来自 Server：

```text
StoryWork
Manifest frozen text
Server TTS profile
```

客户端只允许发送：

```text
workId
segmentIndex
sessionId
```

---

# 27. Guest → User migration

这是 M8 与 M2/M5 的第二个关键集成点。

已有：

```text
guestWorkId 35
      ↓
userWorkId 481
```

映射。

Canonical Audio 不需要重新合成。

---

# 27.1 Migration

DB transaction：

```text
GuestManifest(work 35)
      ↓ copy metadata
UserManifest(work 481)

GuestSegments
      ↓ copy DB rows
UserSegments

storageKey:
保持不变
```

然后：

```text
DELETE GuestAudioSegment rows
DELETE GuestAudioManifest rows
```

### Object bytes

完全不动。

---

# 27.2 为什么删除 Guest audio rows

如果 Guest/User 两边都引用相同 storageKey：

Guest GC 以后很容易：

```text
delete object
```

误伤 User。

因此 Canonical Audio ownership 在注册时：

> **transfer，不 duplicate reference。**

Guest StoryWork 文本继续按 M2 保留至 Guest GC，但：

```text
audioStatus → missing
```

如果旧 Guest identity 再访问，它可以重新生成自己的 audio。

---

# 28. Storage 生命周期

## 28.1 Active

Canonical audio 永久保存。

没有：

```text
“最近 100 条”
```

类型的 silent cleanup。

---

# 28.2 Move to Trash

StoryWork：

```text
deletedAt != null
```

Audio：

```text
完全保留
```

因为 30 天内允许 Restore。

---

# 28.3 Restore

无需任何 Audio 操作。

原 Manifest 继续使用。

---

# 28.4 Permanent Delete

不能简单依靠：

```text
DB ON DELETE CASCADE
```

因为 DB cascade 无法删除外部 S3 object。

必须：

```text
Audio-aware deletion
```

---

# 29. Audio object deletion tombstone

建议新增：

```prisma
model AudioStorageDeletion {
  id Int @id @default(autoincrement())

  storageKey String @unique

  attempts Int @default(0)

  nextAttemptAt DateTime?
  lastError     String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([nextAttemptAt])
}
```

流程：

```text
Permanent Delete
     ↓
DB transaction:
  collect storage keys
  create deletion tombstones
  delete StoryWork
     ↓ commit

best effort:
  storage.delete()
     ↓
success → delete tombstone
failure → retain tombstone
```

---

# 29.1 为什么需要 tombstone

否则：

```text
DB delete success
S3 delete fails
```

以后已经不知道该删除哪个 Object。

结果就是永久 orphan。

---

# 29.2 Retry

当前部署没有 queue / worker。

因此沿用简单模式：

```text
startup cleanup
+
opportunistic cleanup
```

例如：

* App startup；
* permanent delete；
* Guest GC；
* audio ensure 请求的低频机会式触发。

以后如果引入 scheduler，可以无缝消费同一 tombstone 表。

---

# 30. Guest GC

当前 Guest creative data 会按 `updatedAt` 清理。

M8 后 Guest GC 不能继续：

```text
deleteMany GuestStoryWork
```

直接了事。

必须：

```text
1 找到待删除 Guest Works
2 收集所有 Segment storageKey
3 创建 tombstone
4 删除 Guest Works / manifests
5 commit
6 尝试 object cleanup
```

---

# 31. 本地 Storage 删除

同样走 tombstone。

这样 Local / S3 lifecycle 完全一致，不在 domain 层分叉。

---

# 32. Storage migration

因为 DB 只保存：

```text
opaque storageKey
```

不保存：

```text
https://bucket...
/app/audio/...
```

未来 Local → S3：

```text
遍历 ready Segment
  ↓
read local storageKey
  ↓
put S3 same storageKey
  ↓
verify:
  byteLength
  audioChecksum
```

完成以后：

```text
AUDIO_STORAGE_DRIVER=s3
```

DB 无需修改。

这是 storage abstraction 最重要的长期收益之一。

---

# 33. 不存 URL

DB 中严格禁止：

```text
https://xxx.s3.../file.mp3
```

只存：

```text
storageKey
```

否则：

* bucket migration；
* CDN；
* endpoint；
* signed URL；

都会污染数据库。

---

# 34. File-level changes

## 新增

```text
lib/audio/
├── manifest.ts
├── profile.ts
├── duration.ts
├── checksum.ts
└── storage/
    ├── types.ts
    ├── index.ts
    ├── local.ts
    └── s3.ts
```

---

```text
lib/server/
└── storyAudio.ts
```

职责：

```text
resolve/create manifest
claim segment lease
synthesize
persist
lifecycle
projection
```

---

```text
lib/trpc/schemas/
└── storyAudio.ts

lib/trpc/routers/
└── storyAudio.ts
```

---

```text
lib/client/
└── storyAudio.ts
```

---

```text
app/api/audio/segments/[segmentId]/route.ts
```

负责：

```text
ownership
Range
signed redirect
```

---

```text
lib/server/
└── audioStorageCleanup.ts
```

处理 tombstone。

---

# 35. 修改

```text
prisma/schema.prisma
```

新增：

* User Manifest / Segment；
* Guest Manifest / Segment；
* AudioStorageDeletion；
* StoryWork relations。

---

```text
lib/server/openai.ts
```

增加：

```text
synthesizeSpeechWithProfile()
```

当前 `synthesizeSpeech()` 保留 wrapper。

---

```text
lib/trpc/routers/index.ts
```

增加：

```text
storyAudio
```

---

```text
app/services/playbackSessionFlow.ts
```

Work：

```text
fetchAudio
→ storyAudio.ensureSegment
```

Draft 保持旧路径。

---

```text
stores/playbackSessionStore.ts
```

* Work segment provider 接入 Manifest；
* session stale check 继续沿用 M5；
* Manifest segmentation 优先。

---

```text
lib/server/storyWork.ts
```

为 M2 Library DTO 增加：

```text
audio projection
```

---

```text
lib/server/unifiedMigration.ts
```

注册：

```text
transfer Guest Audio ownership
```

---

```text
lib/server/guestGc.ts
```

变成 audio-aware GC。

---

```text
docker-compose.yml
Dockerfile
```

Local backend：

```text
/app/audio
```

以及权限。

---

```text
package.json
```

预计增加：

```text
S3 SDK
MP3 metadata parser
```

当前依赖中尚无对象存储 SDK 或音频 metadata parser。

---

# 36. 迁移步骤

推荐：

```text
M8-A Schema + Storage Abstraction
        ↓
M8-B Canonical Write Path
        ↓
M8-C Work Playback Read Path
        ↓
M8-D Lazy Migration
        ↓
M8-E Lifecycle / GC
        ↓
M8-F Story-level timeline
```

---

# 37. Step A — Schema expand

只增加新表和 relations。

旧 StoryWork：

```text
没有 Manifest
```

自动投影：

```text
audio.status = missing
```

零批量数据 migration。

---

# 38. Step B — Storage abstraction

先实现：

```text
LocalFilesystemStorage
```

作为 integration test backend。

同时完成：

```text
S3Storage
```

生产配置切 Object Storage。

不把业务 service 与任何一个 SDK 直接绑定。

---

# 39. Step C — Canonical ensureSegment

Work 播放开始逐步切换：

```text
tts.synthesize
     ↓
storyAudio.ensureSegment
```

保留 feature flag：

```text
CANONICAL_AUDIO_ENABLED=true/false
```

建议 migration window 使用。

关闭时：

```text
仍走 legacy ephemeral TTS
```

---

# 40. Step D — Lazy migration

无需 migration script 对旧 Works 批量运行。

用户第一次播放时自然资产化。

优势：

```text
TTS cost
≈ 真正被再次播放的旧作品
```

而不是：

```text
全部历史作品
```

---

# 41. Step E — Lifecycle

在正式开启 Canonical production 前，必须同时上线：

```text
permanent delete cleanup
Guest GC cleanup
registration transfer
tombstone retry
```

不能：

> 先开始写 S3，之后再补删除逻辑。

否则 orphan 会从第一天开始积累。

---

# 42. Step F — Full Timeline

所有 Segment ready：

```text
duration[]
```

已经完整。

M7 可以构造：

```text
segmentStart[0] = 0

segmentStart[n] =
sum(duration[0...n-1])
```

从而实现：

```text
Story-level currentTime
Story-level duration
Story-level seek
```

M5 Session identity 无需变化。

---

# 43. Story-level seek

用户 seek 到：

```text
12:32
```

M7：

```text
binary search manifest durations
     ↓
segmentIndex
+
offsetInSegment
```

M5：

```text
play Segment(index)
then audioEl.currentTime = offset
```

这就是之前产品方案中：

> Canonical Audio 完整以后再提供真正的整篇 seek。

---

# 44. 当前段 seek 与未 Ready Segment

如果用户拖到的目标 Segment：

```text
missing
```

则：

```text
Expanded Player
→ preparing
→ ensureSegment
→ ready
→ seek/play
```

不需要提前生成全部音频。

---

# 45. Failure handling

## TTS failure

```text
segment.status = failed
manifest.status = failed
```

保存：

```text
lastErrorCode
```

不保存完整 Provider response。

---

## Storage failure

TTS bytes 不被标为 canonical。

```text
segment != ready
```

避免出现：

```text
DB says ready
but object missing
```

---

## Object unexpectedly missing

Route storage `404`：

```text
segment DB ready
object missing
```

视为 corruption。

Server：

```text
segment → failed/missing
manifest → failed
```

允许下一次重新 synthesis。

---

# 46. Retry

`ensureSegment()` 对 failed Segment：

```text
重新 claim lease
attemptCount += 1
```

不需要额外：

```text
retrySegment
```

API。

保持幂等。

---

# 47. Validation — Unit

必须覆盖：

### Manifest identity

改变：

```text
contentHash
voice
model
backend
synthesisVersion
segmentationVersion
```

必须被识别为不同 profile。

改变：

```text
playbackRate
title
favorite
```

不得改变 audio identity。

---

### Status

覆盖：

```text
no manifest → missing

missing segment
→ preparing
→ missing(partial)

last segment
→ ready

prepare failure
→ failed

retry
→ preparing
```

---

### Segment text freeze

改变全局 segmentation algorithm fixture 后：

旧 Manifest：

```text
segments[].text
```

保持原样。

---

### Storage key

必须：

* opaque；
* unique；
* 不包含 user id；
* 不包含 guest id；
* 不包含 story title；
* 不接受客户端输入。

---

# 48. Validation — Local Storage

真实临时目录：

```text
put
read
range read
delete
stat
```

全部测试。

Range 必须覆盖：

```text
bytes=0-99
bytes=100-
invalid range
```

---

# 49. Validation — S3 adapter

使用 SDK mock / fake endpoint contract 验证：

```text
put
delete
signed GET
metadata
```

M8 不建议为了测试体系增加一个永久 MinIO service。

---

# 50. Validation — Canonical synthesis

Fake TTS：

```text
known text
→ known MP3 fixture
```

验证：

```text
Segment row ready
duration > 0
byteLength correct
checksum correct
object exists
```

自动测试绝不调用真实 OpenAI。

---

# 51. Validation — Concurrency

同时：

```text
Promise.all([
 ensureSegment(work, 2),
 ensureSegment(work, 2),
 ensureSegment(work, 2)
])
```

断言：

```text
TTS invocation count == 1
```

---

# 52. Validation — Lease recovery

构造：

```text
status=preparing
lease expired
```

下一次 ensure：

```text
成功重新 claim
```

---

# 53. Validation — Lazy migration

旧 Work：

```text
audio = missing
```

第一次：

```text
play segment 0
```

之后：

```text
segment 0 ready
```

第二次：

```text
play segment 0
```

断言：

```text
TTS count 不增加
```

---

# 54. Validation — Voice consistency

Work：

```text
voiceId = nova
```

第一次创建 Manifest。

随后修改：

```text
global default voice = alloy
```

继续生成 Segment 2。

必须：

```text
voice = nova
```

---

# 55. Validation — Model pinning

Manifest：

```text
ttsModel = model-A
```

部署配置改成：

```text
model-B
```

旧 Manifest 缺失 Segment：

```text
仍请求 model-A
```

新 Work：

```text
使用 model-B
```

---

# 56. Validation — Speed

用户：

```text
1.5x
```

Canonical synthesis request：

```text
speed = 1.0
```

AudioController：

```text
playbackRate = 1.5
```

不得生成第二份 Asset。

---

# 57. Validation — M5 session stale

```text
A ensure Segment
↓ slow TTS

用户切 B

A 返回 ready
```

Object 可以被保留——因为它是合法 canonical asset。

但 client：

```text
A sessionId != current sessionId
```

不得：

```text
play A
```

这与 M5 stale protection 完全一致。

---

# 58. Validation — Guest registration

Guest：

```text
Work 35
Manifest
Segment asset key X
```

注册：

```text
Work 35 → User Work 481
```

之后：

```text
User Manifest → Work 481
storageKey == X
```

Object Storage：

```text
copy count = 0
TTS count = 0
```

Guest Manifest：

```text
不存在
```

---

# 59. Validation — Trash

Move to Trash：

```text
objects remain
```

Restore：

```text
TTS count = 0
```

当前 Session：

```text
允许 ensure next segment
```

其他 Session：

```text
WORK_UNAVAILABLE
```

---

# 60. Validation — Permanent delete

永久删除：

```text
StoryWork row gone
Manifest row gone
Segment row gone
Deletion tombstone created
```

cleanup 成功：

```text
object gone
tombstone gone
```

模拟 S3 delete fail：

```text
tombstone remains
```

retry 后成功。

---

# 61. Validation — Guest GC

过期 Guest：

```text
StoryWork
Manifest
Segment
Object
```

最终全部被正确清理。

不得遗留 orphan object。

---

# 62. Browser / E2E

M10 至少增加：

```text
旧 Work 首次播放有生成等待
第二次播放直接命中 Canonical

跨页面不重新 TTS

Pause / Resume 不重新 TTS

Refresh Resume 命中已有 Segment

当前段 → 下一段 lookahead

Story 完整听完后显示 duration

Expanded Story-level seek

改播放倍速不产生新 Asset

Trash 当前播放继续

Restore 后不重新生成

Guest 注册后仍能继续播放同一 Canonical Audio
```

---

# 63. 主要风险

| 风险                                        |   严重度 | 处理                                               |
| ----------------------------------------- | ----: | ------------------------------------------------ |
| 大量音频把单机卷打满                                |     高 | 生产推荐 Object Storage                              |
| S3 credentials / endpoint 增加运维项           |     中 | Storage abstraction + env config                 |
| Lazy Segments 跨时间生成导致 Provider alias 声音微变 |     中 | pin model/profile；优先 versioned model             |
| 重复并发 TTS                                  |     高 | Segment lease + unique index                     |
| DB ready 但 object 不存在                     |     高 | storage first → DB ready，读取时 corruption recovery |
| DB 删除成功但 object 删除失败                      |     高 | deletion tombstone                               |
| Guest 注册后 asset ownership 错乱              | **高** | DB ownership transfer，object key 不变              |
| Segmentation 升级后旧 Manifest 无法补段           | **高** | Segment 保存 frozen text                           |
| 用户倍速产生大量重复 asset                          |     高 | Canonical speed 固定 1.0                           |
| Object signed URL 泄露                      |     中 | private bucket + 短 TTL + opaque IDs              |
| Local backend Range 不完整导致 seek 失效         |     中 | route 强制支持 RFC Range                             |
| MP3 duration parser 出错                    |     中 | 未获得 duration 不得 Manifest ready                   |
| Storage backend migration                 |     中 | stable storageKey + checksum verification        |
| S3 写成功、DB 更新前进程 crash                     |   低/中 | deterministic storageKey，retry overwrite         |
| AudioStatus `missing` 同时可能已有部分 segments   |     低 | 定义为“整篇 canonical 未完成”，UI 不将其展示为错误                |

---

# 64. 与 M5 的最终边界

M5：

```text
负责：
谁在播放
播到哪里
Session 是否还有效
Resume / Replay
Progress
```

M8：

```text
负责：
这个 Work 的 Segment 音频有没有
如果没有如何生成
生成结果存在哪里
如何给播放器可播放 URL
```

即：

```text
             StoryWork
                 │
                 ▼
        Playback Session — M5
                 │
                 │ asks segment N
                 ▼
         Story Audio — M8
                 │
        ┌────────┴────────┐
        ▼                 ▼
 Manifest Metadata   Object Storage
        │
        ▼
 playbackUrl
        │
        ▼
 AudioControllerHost
```

任何情况下：

```text
Blob storage migration
```

都不应该改变：

```text
StoryWork.id
PlaybackSourceRef
sessionId
WorkPlaybackProgress
```

---

# 65. 需要拍板项

## M8-P01 — Production Canonical Storage

推荐：

> **生产使用 S3-compatible Object Storage；Local backend 作为开发、小型自托管方案。**

不推荐生产长期默认单机卷。

---

## M8-P02 — Canonical Speed

推荐：

> **Canonical TTS 永远 1.0x；用户倍速完全由播放器 playbackRate 实现。**

否则缓存维度和长期资产身份都会被 speed 污染。

---

## M8-P03 — Lazy 粒度

推荐：

> **按 Segment lazy materialization + lookahead 1。**

不在用户第一次点击播放时生成完整故事。

因此：

```text
audio.status = ready
```

通常在首次完整收听后自然达成。

---

## M8-P04 — Guest 注册后的音频 ownership

推荐：

> **Canonical Audio 转移给新 User；Guest StoryWork 文本仍按 M2 保留，但 Guest Audio Manifest 被移除。**

不复制 Object、不重新 TTS。

---

# 66. M8 完成后的最终效果

旧模式：

```text
每一次播放
    ↓
TTS
    ↓
Base64
    ↓
Blob URL
    ↓
播放结束后资产消失
```

M8 后：

```text
第一次真正需要某 Segment
        ↓
       TTS
        ↓
   Canonical Asset
        ↓
 Object Storage
        ↓
Manifest
        ↓
以后永久复用
```

最终：

```text
StoryWork
   │
   ├── Stable Text Identity
   └── Canonical Audio Manifest
            │
            ├── Segment 0 → MP3 + duration
            ├── Segment 1 → MP3 + duration
            ├── Segment 2 → MP3 + duration
            └── ...
```

从这一层开始，「故事库里的作品」终于真正满足产品层的预期：

> **昨天听过的故事，今天再次点击应该直接播放，而不是再次生成一个“类似但不一定完全一样”的声音。**

同时仍然保留现有 paragraph synthesis 的首播速度优势，而不需要为了资产化把整个播放内核推倒重写。

这里我最建议评审时重点锁定三件事：**Object Storage 是 canonical source、Segment 文本必须冻结进 Manifest、Canonical speed 固定 1.0x**。第三点看起来只是一个 TTS 参数，但实际上决定了以后是不是会因为用户切换倍速而出现多份资产和 duration 混乱。
