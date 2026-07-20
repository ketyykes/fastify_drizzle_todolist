# Proposal: add-transactional-outbox

> 本 change 為**回溯記錄**：程式碼已實作完成並全數測試通過，本文件是補寫的 openspec 軌跡，不代表尚待實作的工作。

## Why

「寫本地 DB」與「打外部 HTTP」是兩個無法原子化的動作：先寫 DB 再打 HTTP，HTTP 失敗就永遠漏掉那筆事件；把 HTTP 包進 DB 交易，外部服務一慢就拖住甚至拖垮本地交易。本專案原有教學情境（todolist）並未示範這個常見的分散式系統痛點與其標準解法。這個 change 把「transactional outbox」模式（去識別化自一個真實生產系統的可靠事件推送機制）落地成一個可實際操作、可觀察狀態流轉的教學範例：**todo 被標記完成時，可靠地通知外部 webhook 服務**。

## What Changes

- 新增 `outbox_messages` 資料表（`packages/db/src/schema/outbox.ts`）：只存 `ref_id` 不存 payload，狀態欄位 `pending / processing / done / dead`，含退避與卡住回收所需欄位。
- 新增後端 `apps/server/src/outbox/` 模組：`constants.ts`（狀態常數、批次上限、卡住門檻）、`backoff.ts`（退避查表純函式）、`config.ts`（讀 env、測試可覆寫）、`repository.ts`（入隊、認領、標記成功/失敗、卡住回收、死信重排、清理、統計）、`sender.ts`（依 `refId` 重抓最新資料現組 payload 送出）、`fast-path.ts`（commit 後 best-effort 立即試送）、`sweeper.ts`（一輪 sweep 的完整邏輯）、`sweep-loop.ts`（可注入、可測試的輪詢迴圈）。
- 修改 `PATCH /todos/:id`（`apps/server/src/routes/todos.ts`）：`completed` 由 `false → true` 的狀態轉移時，於同一交易內 `enqueueOutbox`；commit 後呼叫 `flushOutboxFastPath` best-effort 送出。
- 新增 `POST/GET/PUT /mock-external/*`（`apps/server/src/routes/mock-external.ts`）：無認證的 mock 外部 webhook 服務，可切換 `success / fail / timeout` 模式。
- 新增 `GET /outbox/stats`、`POST /outbox/requeue-dead`、`POST /outbox/sweep`（`apps/server/src/routes/outbox-admin.ts`）：皆需登入。
- 新增獨立 worker 進入點 `apps/server/src/worker.ts`：以 `sweep-loop.ts` 固定間隔跑 `runSweepOnce()`，支援 SIGINT/SIGTERM 優雅退出；`docker-compose.yml` 新增對應 `worker` 服務。
- 新增維運 CLI：`apps/server/src/scripts/outbox-requeue-dead.ts`（`--id=1,2`）、`apps/server/src/scripts/outbox-prune.ts`（`--days=30`），皆含參數解析的邊界驗證。
- 新增環境變數（`packages/env/src/server.ts`）：`OUTBOX_WEBHOOK_URL`、`OUTBOX_SWEEP_INTERVAL_MS`、`OUTBOX_SEND_TIMEOUT_MS`。
- 新增前端教學頁 `/outbox-guide`（`apps/web/src/routes/outbox-guide.tsx`）：雙寫問題說明、架構圖與狀態機圖（SVG）、退避表、即時佇列統計輪詢（`apps/web/src/hooks/use-outbox-stats.ts`、`apps/web/src/lib/outbox-api.ts`），並提供切換 mock 模式／手動 sweep／requeue dead 的操作按鈕；掛上受保護路由與 header 導覽連結。

## Capabilities

### New Capabilities

- `transactional-outbox`：交易內入隊待送出事件、commit 後 fast-path 送出、sweeper 背景輪詢重試與死信轉移、送出前重抓最新資料、卡住回收、維運端點與 CLI、mock 外部服務、前端教學頁即時觀測。

### Modified Capabilities

無。`PATCH /todos/:id` 對外的既有行為（回應格式、狀態碼、跨使用者 404、欄位驗證）未變；新增的 outbox 入隊與 fast-path 屬於該端點內部**新增**的副作用，不修改 `todo-management` capability 既有的任何 requirement，故不列入 Modified。

## Impact

- **資料層 `packages/db`**：新增 `schema/outbox.ts`（`outbox_messages` 表 + 兩個索引）並於 `schema/index.ts` 匯出。
- **後端 `apps/server`**：新增 `src/outbox/*`（8 個模組 + 對應 `.test.ts`）、`src/routes/mock-external.ts`、`src/routes/outbox-admin.ts`、`src/worker.ts`、`src/scripts/outbox-requeue-dead.ts`、`src/scripts/outbox-prune.ts`；修改 `src/routes/todos.ts`（`PATCH /todos/:id`）與 `src/app.ts`（註冊新路由群組）；`package.json` 新增 `worker` / `outbox:requeue-dead` / `outbox:prune` scripts。
- **環境設定 `packages/env`**：`server.ts` 新增 `OUTBOX_WEBHOOK_URL` / `OUTBOX_SWEEP_INTERVAL_MS` / `OUTBOX_SEND_TIMEOUT_MS`，兩份 `.env.example` 同步補上。
- **前端 `apps/web`**：新增 `routes/outbox-guide.tsx`、`hooks/use-outbox-stats.ts`（+ 測試）、`lib/outbox-api.ts`；`router.tsx` 加受保護路由、`components/header.tsx` 加導覽連結。
- **Docker / 設定**：`docker-compose.yml` 新增 `worker` 服務（與 `server` 共用 image，指令改跑 `pnpm --filter server worker`）。
- **外部系統**：無真實外部依賴；`mock-external.ts` 是專案內部模擬的第三方端點，僅供教學與測試使用。
