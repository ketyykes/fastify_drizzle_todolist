# Proposal: add-staging-sync

## Why

從外部服務分頁拉取大量巢狀資料、全量刷新本地資料表，是很常見的整合情境；但天真的做法會在兩個方向踩雷：一次把整批分頁資料全部載入記憶體再寫入，資料量夠大時會把 process 記憶體吃到 OOM；為了避免 OOM 改成「每抓一頁就 commit 一頁」，又會讓「全量刷新」這個天生需要原子性的操作失去原子性——半途失敗時，使用者看到的會是「資料被刪掉一半」的假象（部分列已被標記過期、其餘列還沒來得及復原）。

本專案原有的教學情境（todolist + transactional outbox）並未示範這個「記憶體與原子性兩難」的治本模式。這個 change 把一個真實生產系統驗證過的解法——**逐頁抓取 → staging 暫存表 → 單一交易原子切換（mark-and-sweep）**，並疊加 `sync_runs` 狀態機、advisory lock 互斥、以及 owner_token/lease_version fencing 防止舊 worker 越權寫入——落地成一個可實際操作、可觀察狀態流轉的教學範例：**從 mock 範本庫（template catalog）服務分頁拉取範本清單／項目／標籤，全量刷新本地目錄**。

核心原則貫穿全案：**「分批的是記憶體，不是 commit。」** 記憶體用逐頁處理＋暫存表封頂；commit 只在最後的原子切換那一刻發生一次。

## What Changes

- 新增兩個資料庫 schema 檔案（`packages/db/src/schema/`）：
  - `template-catalog.ts`：3 張目標表 `template_lists`、`template_items`、`template_item_tags`（分別示範單欄鍵、單欄鍵、複合鍵三種 conflict key）。
  - `staging-sync.ts`：`sync_run_phase` enum、`sync_runs` 狀態機表（含 owner_token/lease_version fencing 欄位與 partial unique index）、對應的 3 張 staging 表。
  - 同步更新 `packages/db/src/schema/index.ts` 匯出；`packages/db/src/index.ts` 補充匯出 pg `pool`（`mutex.ts` 需要專用 client 執行 advisory lock）。
- 新增後端模組 `apps/server/src/staging-sync/`（約 14 個檔案＋對應測試）：`constants.ts`、`errors.ts`、`config.ts`、`fence.ts`、`manifest.ts`、`mutex.ts`（PG advisory lock）、`run-manager.ts`（`sync_runs` 狀態機 repository，全程 fencing）、`page-fetcher.ts`（惰性逐頁抓取＋重試）、`page-transformer.ts`（單頁攤平）、`staging-writer.ts`（每頁一個短交易寫暫存表＋更新檢查點）、`merger.ts`（單一交易原子切換：mark-and-sweep＋衍生欄位重算＋失敗回滾重播）、`orchestrator.ts`（Phase 1 協調）、`dispatcher.ts`（Phase 1+2 全流程協調）、`pruner.ts`（保留期限清理）。
- 新增無認證的 `routes/mock-source.ts`：決定性生成的分頁範本庫資料，可切換 `success`／`fail`／`fail_page_2`／`flaky_page_2`／`empty` 模式，並支援 `overlap` 參數模擬分頁漂移。
- 新增需登入的 `routes/staging-sync-admin.ts`：觸發同步、查詢近期執行、放棄 staged 執行、查詢目前生效目錄。
- 新增 4 支維運 CLI（`scripts/staging-sync-run.ts`、`staging-sync-status.ts`、`staging-sync-abandon.ts`、`staging-sync-prune.ts`）。
- 新增環境變數（`packages/env/src/server.ts`）：`STAGING_SYNC_SOURCE_URL`、`STAGING_SYNC_PAGE_SIZE`、`STAGING_SYNC_FETCH_TIMEOUT_MS`（皆附預設值）。
- 修改 `apps/server/src/app.ts`：註冊 `mock-source` 與 `staging-sync-admin` 兩個路由群組。
- 修改 `apps/server/src/test/helpers.ts` 的 `resetDb()`：加入新表的 TRUNCATE（sync_runs、3 張目標表、3 張 staging 表）。
- 新增前端教學頁 `/staging-sync-guide`：說明記憶體/原子性兩難、架構圖、狀態機圖、fencing 概念圖，並提供觸發同步、觀察執行歷程、放棄 staged 執行、瀏覽目前生效目錄的即時操作區。

## Non-Goals（範圍外，詳見 design.md）

- 不做多 `sync_type` 的通用排程調度；本範例僅示範單一 `template_catalog` 同步類型（`manifest.ts` 雖已抽成通用結構，但不在本 change 內擴充第二種類型）。
- 不引入常駐 worker／排程框架讓 pruner 自動定期執行；pruner 以維運 CLI 形式提供，比照人工或外部排程觸發。
- 不追求「切換期間寫入不受影響」；切換交易會整批更新目標表（mark-and-sweep），期間其他想寫入目標表的交易會被列鎖擋住等待 commit。讀取者則因 PostgreSQL MVCC 完全不受影響——commit 前看到舊的一致狀態、commit 後看到新的一致狀態，永遠不會看到「標記到一半」的中間態。
- 不引入分散式鎖元件（如 Redis）；advisory lock 選用 PostgreSQL 原生機制，最小化依賴。

## Capabilities

### New Capabilities

- `staging-sync`：逐頁抓取來源分頁資料、寫入暫存表並更新進度檢查點、以單一交易原子切換（標記—合併—衍生欄位重算）刷新目標表、`sync_runs` 狀態機與 fencing 保護、advisory lock 互斥、背景清理、維運端點與 CLI、mock 來源服務、前端教學頁。

### Modified Capabilities

無。既有 `user-auth`、`todo-management`、`transactional-outbox` capability 的行為皆未變更；本 change 新增的路由與模組彼此獨立，不修改既有 requirement。

## Impact

- **資料層 `packages/db`**：新增 `schema/template-catalog.ts`、`schema/staging-sync.ts`（含 1 個 pgEnum、6 張新表、1 個 partial unique index），並於 `schema/index.ts` 匯出；`src/index.ts` 新增匯出 pg `pool`。
- **後端 `apps/server`**：新增 `src/staging-sync/*`（14 模組＋對應 `.test.ts`）、`src/routes/mock-source.ts`、`src/routes/staging-sync-admin.ts`、`src/scripts/staging-sync-*.ts`（4 支＋測試）；修改 `src/app.ts`（註冊新路由群組）、`src/test/helpers.ts`（`resetDb` 加新表）；`package.json` 新增對應 CLI scripts。
- **環境設定 `packages/env`**：`server.ts` 新增 3 個 `STAGING_SYNC_*` 變數，根目錄與 `apps/server` 的 `.env.example` 同步補上。
- **前端 `apps/web`**：新增 `routes/staging-sync-guide.tsx`、對應 hook（+ 測試）、`lib/staging-sync-api.ts`；`router.tsx` 加受保護路由、`components/header.tsx` 加導覽連結。
- **Docker / 設定**：無新增服務（不需要常駐 worker，寄件於 CLI／管理端點觸發即可）；`docker-compose.yml` 不需修改。
- **外部系統**：無真實外部依賴；`mock-source.ts` 是專案內部模擬的來源服務，僅供教學與測試使用。
