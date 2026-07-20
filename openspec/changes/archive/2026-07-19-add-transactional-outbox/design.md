# Design: add-transactional-outbox

## Context

本專案（`fastify_drizzle_todolist`，pnpm monorepo：`apps/web` React + react-router、`apps/server` Fastify 5 + Drizzle + zod、`packages/db`、`packages/env`）已有 `add-todolist-mvp` 打下的使用者認證與 per-user todos CRUD。這個 change 在其上疊加一個獨立的教學情境：todo 被標記完成時，要「可靠地」通知一個外部 webhook 服務。

「可靠」在這裡具體指：本地交易與外部 HTTP 呼叫是兩個無法原子化的動作，任何一種天真的排序方式都有破綻（先寫 DB 再打 HTTP 會漏事件；把 HTTP 包進交易會被外部拖慢甚至拖垮本地交易）。本範例完整重現一個真實生產系統驗證過的解法：**transactional outbox**——交易內只多寫一列「待送出意圖」，HTTP 一律搬到交易外，失敗交給背景 sweeper 依退避時間重試，最終保證 at-least-once 送達。完整規格見 `docs/outbox/design.md`（本檔為 openspec 視角的濃縮版，決策取捨與原文一致，不逐字複製）。

本 change 是**回溯撰寫**：程式碼、schema、路由、worker、CLI、前端頁面與全部測試皆已完成並全綠，此文件的目的是把已存在的技術決策整理進 openspec 軌跡，而非規劃尚待進行的工作。

## Goals

- 示範 transactional outbox 的完整生命週期：入隊（交易內）→ fast-path（commit 後 best-effort）→ sweeper 背景重試（退避查表）→ 成功／死信。
- 保證 at-least-once：只要業務資料存在，最終一定會送達外部服務（或達重試上限後轉為需人工介入的死信）。
- 讓開發者能透過前端頁面實際操作、觀察狀態流轉（切模式、手動 sweep、requeue dead），而不只是讀文件。
- 完全去識別化：不出現任何來源系統名稱，情境一律以「todo 完成事件 → mock 外部 webhook」描述。

## Non-Goals

- 不追求「剛好送達一次」（exactly-once）；本機制保證的是 at-least-once，外部端點須自行冪等（design.md §「at-least-once 語意」已在前端頁面說明此取捨）。
- 不做多 topic／多事件類型的通用事件匯流排；`topic` 欄位雖通用，但本範例只用到單一 `todo.completed`。
- 不做 outbox 訊息的優先權／排程時間之外的複雜調度（例如按租戶限流）。
- 不做死信的自動重試策略；死信永遠等待人工 `requeue-dead`。
- 不引入訊息佇列（Kafka/RabbitMQ 等）；本範例刻意用最小依賴（一張 Postgres 表 + 輪詢）示範核心概念。

## Decisions

### Decision: outbox 只存 `ref_id`，送出前重抓最新資料

**Choice**: `outbox_messages` 不存事件當下的業務資料快照，只存 `topic` + `ref_id`；`sender.ts` 送出前依 `ref_id` 重新查一次「當下最新」的 todo 現組 payload。

**Rationale**: 若改用回放入隊當下的舊 payload，一旦業務資料在等待重試期間又被修改，外部服務收到的會是過期狀態；重抓保證送出的永遠是「當下最新」，也讓 outbox 表本身更輕量（不需承擔業務資料的完整副本與 schema 演進負擔）。

**Alternatives considered**:
- 入隊時把整份 payload 序列化存進 outbox 表（如 JSON 欄位）：實作更簡單、不必重抓，但會送出過期資料，且業務資料 schema 改變時舊 payload 格式即失去意義。
- 存 payload 但重試時比對版本號決定是否重抓：過度工程，對本教學範例的複雜度不成比例。

### Decision: fast-path（commit 後 best-effort）與 sweeper（背景輪詢）雙軌並行

**Choice**: `PATCH /todos/:id` 交易 commit 之後立刻呼叫 `flushOutboxFastPath` 試送一次；無論成敗都不影響已提交的 API 回應。sweeper 則是獨立 worker 程序每隔固定間隔跑 `runSweepOnce()`，兜底認領所有到期的 `pending` 訊息（含 fast-path 失敗留下的、以及 fast-path 都還沒來得及跑就 crash 的）。

**Rationale**: 純輪詢（無 fast-path）在正常情況下也能保證送達，但使用者要等到下一次輪詢間隔才會看到外部服務收到通知，教學上不夠「即時」；純 fast-path（無 sweeper）則完全沒有失敗重試的兜底機制，違反「可靠」的核心訴求。兩者疊加：正常情況下近乎即時（fast-path），任何失敗情境都有背景兜底（sweeper），且互不假設對方一定會執行。

**Alternatives considered**:
- 只有 sweeper、縮短輪詢間隔（如 1 秒）逼近「即時」：治標不治本，仍有固定延遲，且對外部服務造成不必要的高頻探測。
- 只有 fast-path、失敗時前端輪詢重試：把可靠性責任錯誤地轉嫁到前端／使用者是否還留在頁面上，不符合「伺服器端保證送達」的設計目標。

### Decision: sweeper 認領採 `FOR UPDATE SKIP LOCKED`

**Choice**: `claimDueBatch` 在交易內以 `FOR UPDATE SKIP LOCKED` 鎖定候選列並立刻轉為 `processing`，交易結束即釋放 row lock。

**Rationale**: 多個 sweeper worker（水平擴充）可以安全並行掃描同一張表，被其他 worker 鎖住的候選列會直接跳過，不會有兩個 worker 同時處理同一筆訊息、也不會互相阻塞等待鎖釋放。這是 Postgres 對「工作佇列」場景的標準解法，且不需要額外的分散式鎖元件。

**Alternatives considered**:
- 應用層鎖（例如 Redis 分散式鎖）：需要額外的基礎設施依賴，對本範例的最小化目標過重。
- 樂觀鎖（版本號 + 條件更新重試）：認領階段沒有跨服務併發寫入的複雜度，`FOR UPDATE SKIP LOCKED` 本身就是為此場景設計的資料庫原生功能，更直接。

### Decision: 退避時間採查表而非公式

**Choice**: `backoff.ts` 的 `computeNextAttemptAt` 用固定查表（第 1~4 次失敗分別等 1／5／15／60 分鐘，第 5 次起封頂 360 分鐘），無 jitter，純函式。

**Rationale**: 忠實保留來源系統的既有機制（見 `docs/outbox/design.md` §2）；查表比指數公式更容易讓讀者一眼看懂每次重試的等待時間，教學上更直觀，且邊界值（第 1、4、5、99 次）容易單元測試窮舉驗證。

**Alternatives considered**:
- 指數退避公式（如 `min(base * 2^attempts, cap)`）：業界更常見，但引入公式參數（base、指數）反而增加讀者理解成本，且與來源系統的實際行為不符（回溯記錄應忠實反映已實作行為）。
- 加入 jitter 避免雪崩效應：對單機教學範例的規模不必要，且會讓測試對「下次重試時間」的斷言變成範圍而非精確值，犧牲教學的可預測性。

### Decision: 死信（dead）永不自動重試，僅人工 `requeue-dead` 救援

**Choice**: `attempts` 達 `maxAttempts`（預設 8）即轉 `dead` 並記錄結構化告警 log；`dead` 訊息不受 `pruneDone` 影響（永久保留直到人工處理或手動清理），必須呼叫 `requeueDead` 才會重新排回 `pending` 並歸零 `attempts`。

**Rationale**: 對一個已經連續失敗 8 次的訊息繼續自動重試，多半是在對一個已知打不通的端點做無意義的嘗試；轉死信並停止自動處理，把決策權交還給人（可能是外部服務真的掛了、payload 格式有問題、或該筆資料本身有異常），避免資源浪費與告警疲勞。

**Alternatives considered**:
- 死信後仍以更長間隔繼續自動重試：模糊了「需要人工介入」與「還在正常重試」的界線，告警意義降低。
- 死信直接捨棄不保留：喪失事後追查與人工補送的可能性，對「可靠送達」的訴求是倒退。

### Decision: 死信告警改為結構化 error log（去識別化簡化）

**Choice**: 來源系統把死信告警寫進專用告警資料表；本範例改為 `console.error` 搭配 `[outbox-dead]` 標記的結構化訊息（含 id、topic、refId、attempts、error）。

**Rationale**: 專用告警表通常搭配該系統既有的告警／通知管線（例如轉發到 Slack 或工單系統），這些基礎設施在教學範例中不存在也不必重建；結構化 log 足以示範「死信必須有告警訊號」這個概念，且不引入額外資料表與外部通知依賴。

**Alternatives considered**:
- 也建一張 `outbox_dead_letter_alerts` 表：更貼近來源系統，但對教學範例是不必要的複雜度，且沒有下游消費者去讀這張表。

### Decision: 卡住回收門檻 15 分鐘

**Choice**: `processing` 狀態超過 `STALE_PROCESSING_MINUTES = 15` 分鐘（`lockedAt` 早於 15 分鐘前）視為卡住（worker 處理中途 crash 或異常終止），由 `recoverStaleProcessing()` 自動退回 `pending`。

**Rationale**: 15 分鐘遠大於單筆 HTTP 逾時（10 秒），足以排除「只是剛好還在處理中」的誤判；又不會讓一筆真的卡住的訊息無限期停留在 `processing`（永遠不會被 sweeper 或 fast-path 再次認領）。

**Alternatives considered**:
- 更短的門檻（如 1 分鐘）：與單筆 HTTP 逾時（10 秒）的安全邊際太小，容易誤判仍在正常處理中的訊息為卡住。
- 不做卡住回收，僅靠人工介入：任何一次 worker crash 都會讓該筆訊息永久卡在 `processing`，違反「最終可靠送達」的目標。

### Decision: worker 用獨立輪詢迴圈模組（`sweep-loop.ts`），而非框架排程

**Choice**: 抽出一個可注入、可測試的 `createSweepLoop`（啟動即先跑一輪、固定間隔 tick、in-flight 旗標防重疊、`stop()` 等待進行中的一輪完成），`worker.ts` 只負責組裝（讀 env、串 `runSweepOnce`、接 SIGINT/SIGTERM）。

**Rationale**: 來源系統用框架內建排程（每分鐘跑一次 command）；本專案（Fastify + 純 Node 腳本）沒有對應的框架排程機制，改用獨立輪詢迴圈模組最貼合現有技術棧，且把「排程本身的正確性」（不重疊、可乾淨停止）抽成純邏輯，用假時鐘（`vi.useFakeTimers`）就能精確測試邊界情況，不必依賴真實 wall-clock 等待。

**Alternatives considered**:
- 用 `setInterval` 直接寫在 `worker.ts` 裡：耦合了「讀 env、進程訊號」與「排程正確性」兩件事，前者難以脫離真實進程做單元測試。
- 用 cron 套件排程：對「每隔固定毫秒數輪詢一次」這種簡單需求是不必要的依賴。

### Decision: 前端架構圖與狀態機圖用 SVG 手繪，不引新依賴

**Choice**: `/outbox-guide` 頁面內的架構圖、狀態機圖以內嵌 SVG（`<rect>` + `<path>` + `<text>`）手繪，不引入圖表函式庫。

**Rationale**: 兩張圖的節點與連線數量固定、不需互動式版面重排，手繪 SVG 完全可控（顏色可跟隨 Tailwind 的 CSS 變數做深色模式適配）且零額外套件成本；符合本教學範例「最小依賴」的一貫取向。

**Alternatives considered**:
- 引入 Mermaid 或其他圖表函式庫：功能更強大但引入建置時間與套件體積成本，對兩張固定版面的圖不成比例。

## Risks / Trade-offs

- [Risk] at-least-once 而非 exactly-once：fast-path/sweeper 送出成功但 `markDone` 前 process 剛好 crash，下一輪可能重送 → Mitigation：這是刻意的設計取捨並在前端頁面明確說明；外部端點須自行以 `refId + topic` 做去重／冪等處理。
- [Risk] 退避查表無 jitter，多筆訊息可能在同一時刻集中重試（雷同的失敗時間點）→ Mitigation：教學範例規模小（單機、單一 topic），暫不需要 jitter；正式系統若流量大可在此基礎上疊加隨機抖動。
- [Risk] `sweep-loop` 以 `setInterval` 固定間隔觸發而非「跑完再排下一輪」，若單輪 sweep 耗時經常超過間隔會頻繁跳過（`onSkip`）→ Mitigation：`BATCH_LIMIT = 100` 限制單輪處理量、`onSkip` 有明確 log 可觀察；教學規模下不會構成問題。
- [Risk] mock 外部服務狀態存在 module 層記憶體，多個 server 實例間不共享 → Mitigation：教學範例僅單一 server 進程執行，未涉及水平擴充下的狀態一致性問題。
- [Risk] 死信告警只寫 log、無實際通知管線，正式場景若照搬本範例可能漏看告警 → Mitigation：文件與程式註解已明確標示這是去識別化簡化，正式場景需自行接上告警系統。

## Migration Plan

全新功能，資料表為新增（`outbox_messages`），對既有 `users` / `todos` 表無破壞性變更。

1. `pnpm db:push`（或既有 schema 同步機制）建立 `outbox_messages` 表。
2. 補上 `.env` 的 `OUTBOX_WEBHOOK_URL` / `OUTBOX_SWEEP_INTERVAL_MS` / `OUTBOX_SEND_TIMEOUT_MS`（皆有預設值，可省略）。
3. `docker compose up` 額外啟動 `worker` 服務（獨立於 `server`，共用 image）。
4. Rollback：移除 `worker` 服務、還原 `todos.ts` 的 outbox 呼叫、`db:push` 移除 `outbox_messages` 表；因無其他表依賴此表，回滾風險低。

## Open Questions

- 是否需要在正式（非教學）場景補上真正的告警管線（取代目前的 `console.error`）？本範例刻意不做，留給讀者依自身環境接上。
- `topic` 目前只有 `todo.completed` 一種；若未來要示範多 topic 的路由分派，`sender.ts` 需要從單一硬編碼送出邏輯改為依 `topic` 查表分派——本 change 範圍內不需要，留待未來擴充。
