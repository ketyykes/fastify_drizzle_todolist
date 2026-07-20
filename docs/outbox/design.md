# Transactional Outbox 教學範例 — 設計規格

> 本文件是本專案「transactional outbox 模式」教學範例的設計依據。
> 模式源自一個真實生產系統的去識別化改寫：該系統需在本地交易完成後，
> 將業務事件可靠地推送到外部服務（以下一律以「外部 webhook 服務」代稱）。
> 本範例把同一套機制落地到 todolist 情境：**todo 被標記完成時，
> 可靠地通知外部 webhook 服務**。

## 1. 要解決的問題（雙寫問題）

「寫本地 DB」和「打外部 HTTP」是兩個不可原子化的動作：

- 先寫 DB 再打 HTTP：HTTP 失敗 → 外部服務永遠漏掉這筆事件。
- 在 DB 交易內打 HTTP：外部服務慢/掛 → 本地交易被拖住（持鎖）、甚至整筆回滾。

**Transactional outbox** 的解法：交易內只多寫一列「待送出意圖」到 outbox 表
（與業務資料原子提交），HTTP 一律在交易外進行；失敗由背景 sweeper 重試。

## 2. 核心設計決策（自來源系統忠實保留）

1. **outbox 只存 `ref_id`，不存 payload**：重送時依 `ref_id` 重抓「最新」業務資料
   現組 payload，而非回放入隊當下的舊資料 —— 避免送出過期狀態。
2. **fast-path**：交易 commit 後立刻 best-effort 試送一次。成功 → `done`
   （正常情況同步近即時，outbox 只是保險）；失敗 → 留在 `pending` 交給 sweeper。
3. **sweeper 用 `FOR UPDATE SKIP LOCKED` 認領**：多個 worker 並行也不會重複處理。
4. **退避查表**（非公式）：第 1~4 次失敗後分別等 1 / 5 / 15 / 60 分鐘，第 5 次起
   封頂 360 分鐘。無 jitter。
5. **死信（dead）**：attempts 達 `max_attempts`（預設 8）轉 `dead`，寫告警，
   等待人工 `requeue-dead` 救援；`dead` 不會被 prune 刪除。
6. **卡住回收**：`processing` 超過 15 分鐘（worker 處理中 crash）自動退回 `pending`。
7. **HTTP 逾時 10 秒**：送出動作永遠不在任何 DB 交易 / row lock 之內。

與來源系統的刻意差異（去識別化 / 簡化）：

- 死信告警：來源系統寫入專用告警資料表；本範例改為結構化 error log（`[outbox-dead]` 標記）。
- 狀態字串：來源系統散落字面量；本範例集中成 `OUTBOX_STATUS` 常數。
- 排程：來源系統用框架排程每分鐘跑 command；本範例用獨立 worker 程序內建輪詢。

## 3. 資料表 `outbox_messages`（packages/db/src/schema/outbox.ts）

| 欄位              | 型別                 | 預設                                   | 說明                                    |
| ----------------- | -------------------- | -------------------------------------- | --------------------------------------- |
| `id`              | serial PK            |                                        |                                         |
| `topic`           | varchar(50) not null |                                        | 事件類型，本範例為 `todo.completed`     |
| `ref_id`          | integer not null     |                                        | 業務主鍵（todos.id）。**不存 payload**  |
| `action`          | varchar(30) not null | `'sync'`                               | 事件動作別；同一 ref 允許多筆           |
| `status`          | varchar(20) not null | `'pending'`                            | pending / processing / done / dead      |
| `attempts`        | integer not null     | `0`                                    | 已嘗試次數                              |
| `max_attempts`    | integer not null     | `8`                                    | 嘗試上限                                |
| `next_attempt_at` | timestamp null       | 入隊時 = now                           | 下次可重送時間（退避）                  |
| `last_error`      | text null            |                                        | 最近一次失敗訊息                        |
| `locked_at`       | timestamp null       |                                        | 認領時間（配合 SKIP LOCKED 與卡住回收） |
| `created_at`      | timestamp not null   | now                                    |                                         |
| `updated_at`      | timestamp not null   | now，更新時由 drizzle `$onUpdate` 維護 |                                         |

索引：`idx_outbox_status_next (status, next_attempt_at)`（sweeper 撈件）、
`idx_outbox_topic_ref (topic, ref_id)`（依 ref 查詢）。**刻意不設唯一索引**
（同一 ref 可有多筆不同事件）。

## 4. 狀態機

```
(enqueue，交易內) ──► pending ──認領──► processing ──成功/ref已刪──► done ──30天後──► (prune 刪除)
                        ▲  ▲              │
     fast-path 失敗留原地┘  │              ├─失敗未達上限（attempts+1、退避）──► pending
                           │              └─失敗達上限──► dead ──人工 requeue-dead──► pending
                           └──processing 卡住逾 15 分鐘自動退回──┘
（fast-path 成功：pending ──► done，不經 processing）
```

## 5. 模組配置（apps/server/src/outbox/）

- `constants.ts`：`OUTBOX_STATUS`、`BATCH_LIMIT = 100`、`STALE_PROCESSING_MINUTES = 15`。
- `backoff.ts`：`computeNextAttemptAt(attempts: number, now: Date): Date`。
  查表 `{1:1, 2:5, 3:15, 4:60}` 分鐘，其餘 360。純函式。
- `repository.ts`（皆操作 `outboxMessages`）：
  - `enqueueOutbox(tx, { topic, refId, action? })`：**必須在呼叫端交易內**執行 insert，回傳 id。
  - `claimDueBatch(limit)`：交易內 `status='pending' AND next_attempt_at <= now`
    → `ORDER BY id`（舊到新）→ `LIMIT n` → `FOR UPDATE SKIP LOCKED` → 立刻
    update 成 `processing` + `locked_at = now`，交易結束釋放 row lock，回傳認領列。
  - `recoverStaleProcessing()`：`processing` 且 `locked_at < now - 15min` → 退回 `pending`、清 `locked_at`，回傳筆數。
  - `markDone(id)`：`done`、清 `locked_at`。
  - `markFailed(row, errorMessage)`：`attempts+1`；達上限 → `dead` ＋ `[outbox-dead]` error log；
    否則 → `pending` ＋ `next_attempt_at = computeNextAttemptAt(newAttempts)`、清 `locked_at`。
  - `requeueDead(ids?)`：`dead` →（可指定 id，省略=全部）`pending`、`attempts=0`、
    `last_error=null`、`next_attempt_at=now`、清 `locked_at`。
  - `pruneDone(retentionDays = 30)`：只硬刪 `done` 且 `updated_at < cutoff`。dead/pending/processing 一律保留。
  - `getOutboxStats()`：各狀態計數 ＋ 最近 20 列（id desc）。
- `sender.ts`：`sendOutboxMessage(row, config)`：
  1. 依 `row.refId` **重抓最新 todo**；todo 已不存在 → 回傳 `{ skipped: true }`（呼叫端 markDone）。
  2. POST `config.webhookUrl`，payload `{ topic, refId, action, todo: {...}, sentAt }`，
     timeout `config.timeoutMs`（預設 10000）。非 2xx 或網路錯誤 → throw。
- `config.ts`：`getOutboxConfig()` 讀 env，並提供 `setOutboxConfigForTest()` 覆寫
  （測試把 webhookUrl 指到 ephemeral port 的 mock server）。
- `sweeper.ts`：`runSweepOnce()`：
  1. `recoverStaleProcessing()`。
  2. `claimDueBatch(100)`。
  3. 逐筆（**交易外**）：send 成功或 skipped → `markDone`；失敗 → `markFailed`；
     單筆意外例外 → log warning、該列留在 `processing`（下一輪卡住回收接手），不中斷整批。
  4. 回傳 `{ recovered, done, retried, dead }` 計數。

## 6. 事件觸發與 fast-path（routes/todos.ts 改造）

`PATCH /todos/:id` 當 `completed` 由 false → true（狀態轉移，非只要帶 completed=true）：

```
db.transaction:
  讀取現有 todo（含 userId 隔離）
  update todos
  若發生 false→true 轉移：enqueueOutbox(tx, { topic: "todo.completed", refId: id })
commit 之後：
  flushOutboxFastPath(outboxId)   ← try/catch 包住，任何失敗都不影響已提交的更新回應
```

`flushOutboxFastPath`：試送一次；成功 → markDone；失敗 → `attempts=1`、`last_error`、
`next_attempt_at = computeNextAttemptAt(1)`（**status 維持 pending**，不經 processing）。

## 7. HTTP 端點

Mock 外部服務（**無**認證，模擬第三方；狀態存 module 層記憶體）：

- `POST /mock-external/notifications`：依當前模式回應 —
  `success` → 200 並記錄收到的 payload；`fail` → 500；`timeout` → 延遲超過 sender timeout 後才回。
- `GET  /mock-external/notifications` → `{ mode, received: [...] }`
- `PUT  /mock-external/mode` body `{ mode: "success" | "fail" | "timeout" }`
- `POST /mock-external/reset`：清空已收清單（測試/示範用）

Outbox 管理（掛 `app.authenticate`）：

- `GET  /outbox/stats` → `{ counts: { pending, processing, done, dead }, recent: [最近20列] }`
- `POST /outbox/requeue-dead` body `{ ids?: number[] }` → `{ requeued: n }`
- `POST /outbox/sweep`：手動觸發一輪 `runSweepOnce()`（示範/前端演示用）→ 計數結果

## 8. Worker 與維運指令

- `apps/server/src/worker.ts`：獨立進入點。每 `OUTBOX_SWEEP_INTERVAL_MS`（預設 60000）
  跑一輪 `runSweepOnce()`，以 in-flight 旗標防重疊，SIGINT/SIGTERM 優雅退出。
- `apps/server/src/scripts/outbox-requeue-dead.ts`：`--id=1,2` 指定或省略=全部 dead；
  帶了 `--id` 但為空/非數字 → 報錯退出（防誤觸全部）。
- `apps/server/src/scripts/outbox-prune.ts`：`--days=30`，`< 1` 報錯。
- package.json scripts：`worker`（tsx src/worker.ts）、`outbox:requeue-dead`、`outbox:prune`。
- docker-compose 增加 `worker` 服務（同 server image，指令改跑 worker）。

## 9. 環境變數（packages/env/src/server.ts ＋ 兩份 .env.example）

- `OUTBOX_WEBHOOK_URL`：z.url()，預設 `http://localhost:7529/mock-external/notifications`
- `OUTBOX_SWEEP_INTERVAL_MS`：coerce number，預設 60000
- `OUTBOX_SEND_TIMEOUT_MS`：coerce number，預設 10000

## 10. 測試策略（TDD，先紅後綠）

- 打真 Postgres（沿用現有整合測試基礎設施）；`resetDb()` 加 `outbox_messages` TRUNCATE。
- mock 外部目標：測試內以 `app.listen({ port: 0 })` 起真實 HTTP ＋
  `setOutboxConfigForTest()` 指向 ephemeral port，**不可依賴 7529 dev server**。
- 覆蓋重點：退避查表邊界（1/2/3/4/5/99 次）、claim 排除未到期與非 pending、
  claim 後成 processing、卡住回收邊界、markFailed 達上限轉 dead、requeueDead 重置欄位、
  prune 只刪過期 done、sender 重抓最新資料（入隊後改 title 送出的是新 title）、
  ref 已刪 → done 跳過、fast-path 成功/失敗兩路、completed false→true 才入隊
  （true→true、只改 title 不入隊）、sweep 整輪狀態轉移、單筆失敗不中斷整批。

## 11. 前端知識頁（apps/web，`/outbox-guide`）

react-router v8 子路由＋Header NavLink。內容：雙寫問題、架構圖（SVG/CSS 繪製，不引新依賴）、
狀態機圖、fast-path 與 sweeper 時序、退避表、設計取捨說明；並以 `httpClient` 串
`GET /outbox/stats` 輪詢顯示即時佇列狀態，提供「切換 mock 模式 / 手動 sweep / requeue dead」
操作按鈕，讓讀者實際操作觀察狀態流轉。

## 12. 程式風格約束（沿用專案慣例）

繁中註解、雙引號＋分號＋printWidth 100、`import type`、`noUncheckedIndexedAccess`
（索引取值處理 undefined）、無未用變數、全 ESM、Fastify route 群組
`export async function xxxRoutes(app)`、zod v4（`z.url()` 頂層函式）。
