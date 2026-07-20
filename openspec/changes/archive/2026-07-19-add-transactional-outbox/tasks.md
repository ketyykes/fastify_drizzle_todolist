# Tasks: add-transactional-outbox

<!--
  回溯記錄：本 change 為已實作完成並全數測試通過之後補寫的軌跡文件。
  下列所有任務皆已完成，checkbox 全數標為 [x]；順序依實際開發歷程與模組依賴回填，
  非事先規劃。測試名稱對齊 test-plan.md，皆取自實際存在的 .test.ts 檔案。
  §0、§8、§9（部分）、§10 為無法單元測試驅動的基礎建設 / glue code / UI 接線，
  明確標示為非 TDD；其餘群組一律 RED → GREEN 配對。
-->

## 0. 前置基礎建設（非 TDD，後續 RED 依賴）

- [x] 0.1 新增 `packages/db/src/schema/outbox.ts`：`outbox_messages` 表（`topic`/`refId`/
      `action`/`status`/`attempts`/`maxAttempts`/`nextAttemptAt`/`lastError`/`lockedAt`/
      `createdAt`/`updatedAt`）與兩個索引（`idx_outbox_status_next`、`idx_outbox_topic_ref`），
      並於 `schema/index.ts` 匯出；`pnpm db:push` 建表
- [x] 0.2 `packages/env/src/server.ts` 新增 `OUTBOX_WEBHOOK_URL`（`z.url()`，預設指向
      `mock-external`）、`OUTBOX_SWEEP_INTERVAL_MS`、`OUTBOX_SEND_TIMEOUT_MS`（皆
      `z.coerce.number().int().positive()`，有預設值），兩份 `.env.example` 同步補上
- [x] 0.3 `apps/server/src/outbox/constants.ts`：`OUTBOX_STATUS` 常數、`BATCH_LIMIT = 100`、
      `STALE_PROCESSING_MINUTES = 15`
- [x] 0.4 `apps/server/src/outbox/config.ts`：`getOutboxConfig()` 讀 env、
      `setOutboxConfigForTest()` 供測試覆寫 webhook 目標
- [x] 0.5 測試基礎：`resetDb()`（`apps/server/src/test/helpers.ts`）加入 `outbox_messages`
      TRUNCATE，供各 outbox 測試共用

## 1. 退避查表（transactional-outbox）
Depends on: §0

- [x] 1.1 RED: 寫測試 `computeNextAttemptAt` 第 1/2/3/4/5/99 次失敗（`backoff.test.ts`
      的 `it.each`）
- [x] 1.2 GREEN: 實作 `backoff.ts` 的 `computeNextAttemptAt`（查表 1/5/15/60 分鐘，
      第 5 次起封頂 360 分鐘，無 jitter，純函式）

## 2. Repository：入隊、認領、狀態轉移、統計（transactional-outbox）
Depends on: §0, §1

- [x] 2.1 RED: 寫測試 `enqueueOutbox` 必須在交易內執行 insert，並回傳新列 id
- [x] 2.2 GREEN: 實作 `repository.ts` 的 `enqueueOutbox(tx, { topic, refId, action? })`
- [x] 2.3 RED: 寫測試 `claimDueBatch` 排除未到期與非 pending、認領後轉 processing、
      依 id 排序、遵守 limit（4 個案例）
- [x] 2.4 GREEN: 實作 `claimDueBatch(limit)`：交易內 `FOR UPDATE SKIP LOCKED` 認領到期
      `pending` → 立刻轉 `processing` + `lockedAt`
- [x] 2.5 RED: 寫測試 `recoverStaleProcessing` 卡住超過 15 分鐘退回 pending、未卡住不受
      影響、非 processing 不受影響（3 個案例）
- [x] 2.6 GREEN: 實作 `recoverStaleProcessing()`
- [x] 2.7 RED: 寫測試 `markDone` 標記為 done 並清除 locked_at
- [x] 2.8 GREEN: 實作 `markDone(id)`
- [x] 2.9 RED: 寫測試 `markFailed` 未達上限退回 pending 依查表設定 next_attempt_at、
      達上限轉 dead（2 個案例）
- [x] 2.10 GREEN: 實作 `markFailed(row, errorMessage)`（含達上限時的 `[outbox-dead]`
      結構化告警 log）
- [x] 2.11 RED: 寫測試 `requeueDead` 指定 id 只重排該幾筆、省略 id 重排全部（2 個案例）
- [x] 2.12 GREEN: 實作 `requeueDead(ids?)`
- [x] 2.13 RED: 寫測試 `pruneDone` 只硬刪過期 done，dead/pending/processing 一律保留
- [x] 2.14 GREEN: 實作 `pruneDone(retentionDays)`
- [x] 2.15 RED: 寫測試 `getOutboxStats` 回傳各狀態計數與最近 20 列（id desc）
- [x] 2.16 GREEN: 實作 `getOutboxStats()`

## 3. Sender：重抓最新資料送出（transactional-outbox）
Depends on: §0

- [x] 3.1 RED: 寫測試 `sendOutboxMessage` 依 refId 重抓最新 todo（入隊後改 title，送出
      的是新 title）
- [x] 3.2 RED: 寫測試 ref 已刪（todo 不存在）→ 回傳 skipped，不發出 HTTP 請求
- [x] 3.3 RED: 寫測試外部服務回傳非 2xx → 拋出錯誤
- [x] 3.4 RED: 寫測試逾時 → 拋出錯誤
- [x] 3.5 GREEN: 實作 `sender.ts` 的 `sendOutboxMessage(row, config)`（查最新 todo →
      不存在回 skipped；POST webhookUrl，`AbortSignal.timeout` 逾時；非 2xx/逾時皆
      throw）

## 4. Fast-path：commit 後 best-effort 試送（transactional-outbox）
Depends on: §2, §3

- [x] 4.1 RED: 寫測試 `completed false→true 入隊一筆，fast-path 成功後列變 done 且
      mock 收到 payload`（`todos.test.ts`）
- [x] 4.2 GREEN: 實作 `fast-path.ts` 的 `flushOutboxFastPath(outboxId)`（送出成功→
      markDone；失敗→重用 markFailed；全程 try/catch 不拋出）；修改
      `routes/todos.ts` 的 `PATCH /todos/:id`：`completed` false→true 時於交易內
      `enqueueOutbox`，commit 後呼叫 `flushOutboxFastPath`
- [x] 4.3 RED: 寫測試 `completed true→true 不重複入隊`
- [x] 4.4 GREEN: 確認入隊條件為 `existing.completed === false && row.completed === true`
      （既有邏輯已滿足，補上回歸測試）
- [x] 4.5 RED: 寫測試 `只改 title 不入隊`
- [x] 4.6 GREEN: 確認 `body.data.completed === undefined` 時不觸發入隊（既有邏輯已滿足）
- [x] 4.7 RED: 寫測試 `他人 todo 仍回 404，且不入隊`
- [x] 4.8 GREEN: 確認查詢條件的 `user_id` 過濾同時保護「更新」與「入隊」兩者
      （既有邏輯已滿足）
- [x] 4.9 RED: 寫測試 `fast-path 失敗（mode=fail）→ 列留 pending、attempts=1、有
      last_error 與 next_attempt_at，PATCH 回應仍 200`
- [x] 4.10 GREEN: 確認 `flushOutboxFastPath` 失敗路徑不拋出、不影響 PATCH 回應
      （既有邏輯已滿足）

## 5. Sweeper：一輪 sweep 的完整狀態轉移（transactional-outbox）
Depends on: §2, §3

- [x] 5.1 RED: 寫測試 `runSweepOnce` 整輪完成狀態轉移：成功/退避重試/轉死信/卡住回收
      皆各自正確，單筆失敗不中斷整批，並回傳正確計數
- [x] 5.2 RED: 寫測試批次全數為 pending 但無到期列時，回傳全零計數
- [x] 5.3 GREEN: 實作 `sweeper.ts` 的 `runSweepOnce()`：`recoverStaleProcessing` →
      `claimDueBatch(BATCH_LIMIT)` → 逐筆（交易外）送出 → 成功/skipped 轉 done、
      失敗轉 markFailed；單筆意外例外只記警告、留在 processing、不中斷整批

## 6. Worker 輪詢迴圈（transactional-outbox）
Depends on: §5

- [x] 6.1 RED: 寫測試輪詢迴圈啟動即先跑一輪、之後每隔 intervalMs 觸發一輪、上一輪未
      完成時跳過本輪（呼叫 onSkip）且不重疊、stop 後不再觸發、stop 等待目前這輪完成
      才 resolve 並呼叫 onResult（5 個案例）
- [x] 6.2 GREEN: 實作 `sweep-loop.ts` 的 `createSweepLoop(options)`（`setInterval` +
      in-flight 旗標防重疊；`stop()` 回傳等待目前這輪完成的 Promise）
- [x] 6.3 GREEN（非 TDD glue）: 實作 `worker.ts` 獨立進入點：讀 `env.OUTBOX_SWEEP_INTERVAL_MS`
      組裝 `createSweepLoop({ sweep: runSweepOnce, ... })`，接 SIGINT/SIGTERM 優雅退出；
      `docker-compose.yml` 新增 `worker` 服務（共用 image，指令改跑
      `pnpm --filter server worker`）

## 7. Mock 外部 webhook 服務（transactional-outbox）
Depends on: §0

- [x] 7.1 RED: 寫測試預設 mode 為 success 且 received 為空陣列
- [x] 7.2 RED: 寫測試可切換 mode 為 fail / timeout / success、非法 mode 值回 400
- [x] 7.3 RED: 寫測試 success 模式回 200 並記錄 payload、fail 模式回 500 且不記錄、
      timeout 模式延遲超過 sender timeout 才回應 200
- [x] 7.4 RED: 寫測試 reset 端點清空 received 清單
- [x] 7.5 GREEN: 實作 `routes/mock-external.ts`（module 層記憶體存 `mode`/`received`，
      四個端點：POST notifications、GET notifications、PUT mode、POST reset；於
      `app.ts` 註冊 `mockExternalRoutes`）；新增 `resetMockExternalState()` 供測試重置

## 8. Outbox 維運端點（transactional-outbox）
Depends on: §2, §5

- [x] 8.1 RED: 寫測試未帶 token 呼叫三支端點皆回 401
- [x] 8.2 RED: 寫測試 `GET /outbox/stats` 回傳各狀態計數與最近 20 列
- [x] 8.3 RED: 寫測試 `POST /outbox/sweep` 實際觸發一輪 sweep：到期 pending 轉為 done
- [x] 8.4 RED: 寫測試 `POST /outbox/requeue-dead` 指定 ids 只重排該幾筆、省略 ids 重排
      全部、body 格式不合法回 400（3 個案例）
- [x] 8.5 GREEN: 實作 `routes/outbox-admin.ts`（`app.authenticate` preHandler 掛全群組；
      三個端點依序呼叫 `getOutboxStats`/`runSweepOnce`/`requeueDead`）；於 `app.ts`
      註冊 `outboxAdminRoutes`

## 9. 維運 CLI（transactional-outbox，參數解析 TDD，main 為 glue code 非 TDD）
Depends on: §2

- [x] 9.1 RED: 寫測試 `parsePruneArgs` 省略 --days 預設 30、--days=10、--days=1 邊界值
      合法、其他不相干參數不影響解析（4 個案例）
- [x] 9.2 RED: 寫測試 `parsePruneArgs` --days=0/-5/abc/空值皆回傳錯誤（4 個案例）
- [x] 9.3 GREEN: 實作 `scripts/outbox-prune.ts` 的 `parsePruneArgs(argv)`（純函式）與
      `main()`（呼叫 `pruneDone`，僅在直接執行本檔時觸發，供測試 import 不誤跑）
- [x] 9.4 RED: 寫測試 `parseRequeueDeadArgs` 省略 --id、--id=1、--id=1,2,3、容許空白、
      其他不相干參數不影響解析（5 個案例）
- [x] 9.5 RED: 寫測試 `parseRequeueDeadArgs` --id= 空值/1,,2/abc/1,abc,2/0 或負數皆回傳
      錯誤（5 個案例）
- [x] 9.6 GREEN: 實作 `scripts/outbox-requeue-dead.ts` 的 `parseRequeueDeadArgs(argv)`
      與 `main()`（呼叫 `requeueDead`）
- [x] 9.7 GREEN（非 TDD glue）: `apps/server/package.json` 新增 `worker` /
      `outbox:requeue-dead` / `outbox:prune` scripts

## 10. 前端：即時統計 hook 與教學頁（transactional-outbox）
Depends on: §8

- [x] 10.1 RED: 寫測試 `loads_stats_successfully`
- [x] 10.2 RED: 寫測試 `sets_error_on_fetch_failure`
- [x] 10.3 RED: 寫測試 `polls_on_interval_and_refetches`
- [x] 10.4 RED: 寫測試 `switch_mode_calls_api_and_updates_state`
- [x] 10.5 RED: 寫測試 `sweep_calls_api_and_refetches_stats`
- [x] 10.6 RED: 寫測試 `requeue_dead_calls_api_and_refetches_stats`
- [x] 10.7 GREEN: 實作 `lib/outbox-api.ts`（`fetchOutboxStats`/`sweepOutbox`/
      `requeueDeadOutbox`/`fetchMockExternalState`/`setMockExternalMode`，皆走
      `httpClient`）與 `hooks/use-outbox-stats.ts`（輪詢 + 操作方法 + loading/error
      狀態管理）
- [x] 10.8 建立 `routes/outbox-guide.tsx`（UI 接線，非 TDD）：雙寫問題說明、
      `ArchitectureDiagram`／`StateMachineDiagram`（內嵌 SVG）、退避表、關鍵設計說明
      卡片、即時演示區（統計卡片、mode 切換按鈕、手動 Sweep/Requeue Dead 按鈕、
      最近 20 筆訊息表格）
- [x] 10.9 `router.tsx` 加受保護路由 `/outbox-guide`；`components/header.tsx` 加
      `NavLink` 導覽連結（UI 接線，非 TDD）

## 11. 手動端到端驗證（非 TDD）
Depends on: §4, §5, §6, §7, §8, §10

- [x] 11.1 手動端到端驗證：`docker compose up` 起 db/server/worker，本機 `pnpm dev:web`；
      於 `/outbox-guide` 切 mock 模式為 fail、到 `/todos` 完成一筆 todo、確認 pending
      累積與 attempts 增加；切回 success 並按手動 Sweep（或等待 worker 輪詢），確認
      轉為 done；製造死信情境後以 Requeue Dead 重排，確認回到 pending
