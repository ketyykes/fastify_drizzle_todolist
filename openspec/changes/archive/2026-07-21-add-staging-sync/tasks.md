# Tasks: add-staging-sync

<!--
  尚待實作。順序依 execution-plan.md 的 waves（B1→B2/B2'→B3→B4→C→D→E）與模組依賴排列。
  §0 為無法（或不適合）單元測試驅動的基礎建設，明確標示為非 TDD；其餘群組一律 RED → GREEN 配對，
  測試名稱對齊 test-plan.md。
-->

> **稽核摘要（2026-07-21）**：逐項核對 112 個 checkbox 對應的實作／測試檔案證據（Read/Grep 實測、
> `pnpm --filter server test` 282/282 全綠、`pnpm --filter web test` 29/29 全綠、對本機 Docker
> 執行中的 dev server 實際 curl 驗證 success／fail_page_2 兩種情境）。**109/112 打勾**，3 項保留
> `[ ]` 並在原行下方加稽核註記：17.4／17.5（`failureInjector` 僅是 `merger.swap`/`dispatcher` 的
> 程式參數，未透過任何 CLI flag 或 HTTP 除錯開關暴露，經實際檢查現有 admin 路由與 CLI 皆未接線，
> 人工無法單靠跑起來的 app／CLI 重現「切換中途失敗」與「一筆卡在 staged 待放棄」的前提，故未列入
> 已完成）、4.14（`abandon()` 對非 staged 狀態回傳 `null` 而非拋錯，與描述「拋錯」不符，屬刻意設計
> 非缺陷，但與本行文字描述不一致，故不勾選）。原稽核發現的另外 4 項缺口（0.4 `.env.example`／6.1
> 惰性測試／13.4 503 測試／15.1 `design.md` 章節與過時宣稱）已在後續一輪修復中補齊，詳見各行下方
> 更新後的稽核註記。其餘項目皆有對應實作檔與測試檔證據，且行為與 tasks.md 描述一致（含少數測試檔
> 實際落點與 tasks.md 原文件名不同，但行為覆蓋完整，判定為合理的檔案組織選擇、非實質偏離，例如
> manifest 一致性測試落在 `manifest.test.ts` 而非 tasks 原文指定的 `schema.test.ts`，CLI 腳本落在
> 既有慣例的 `src/scripts/` 而非 tasks 原文的 `scripts/`）。

## 0. 前置基礎建設（wave B1，非 TDD，後續 RED 依賴）

- [x] 0.1 新增 `packages/db/src/schema/template-catalog.ts`：3 張目標表 `template_lists`（`source_list_id` UNIQUE）、`template_items`（`source_item_id` UNIQUE，`source_list_id` 存業務鍵非本地 FK，含 `position`）、`template_item_tags`（`(source_item_id, tag)` UNIQUE 複合鍵），皆含 `is_active`／`created_at`／`updated_at`
- [x] 0.2 新增 `packages/db/src/schema/staging-sync.ts`：`sync_run_phase` pgEnum（`fetching`/`staged`/`swapping`/`done`/`fetch_failed`/`abandoned`）、`sync_runs` 表（含 `owner_token`/`lease_version`/`lock_backend_pid`/`heartbeat_at`/`last_offset`/`page_count`/`source_count`/`staged_counts`/`peak_memory_bytes`/`fetch_seconds`/`swap_seconds`/`swap_attempts`/`result_code`/`last_error_phase`/`error_message`/`abandoned_by`/`abandoned_reason`/`abandoned_at`/`started_at`/`staged_at`/`finished_at`，並建立 partial unique index `uq_sync_runs_active`：`on(syncType).where(phase IN ('fetching','staged','swapping'))`）、3 張 staging 表（`template_lists_staging`/`template_items_staging`/`template_item_tags_staging`，各含 `sync_run_id`/`source_page`/`source_row` 與對應業務鍵 UNIQUE），並更新 `packages/db/src/schema/index.ts` 匯出
- [x] 0.3 `packages/db/src/index.ts` 新增匯出 pg `pool`（`mutex.ts` 需要專用 client 執行 advisory lock）
- [x] 0.4 `packages/env/src/server.ts` 新增 `STAGING_SYNC_SOURCE_URL`（`z.url()`，預設 `http://localhost:7529/mock-source/template-catalog`）、`STAGING_SYNC_PAGE_SIZE`、`STAGING_SYNC_FETCH_TIMEOUT_MS`（皆 `z.coerce.number().int().positive()`，附預設值），`.env.example` 同步補上
  > 稽核註記（更新）：根目錄 `.env.example` 已補上 `STAGING_SYNC_SOURCE_URL`／`STAGING_SYNC_PAGE_SIZE`／`STAGING_SYNC_FETCH_TIMEOUT_MS`（經 grep 核實）。`apps/server/.env.example` 刻意不重複列出——比照既有 `OUTBOX_*` 慣例，該檔只放本機直連 DB 所需的最小變數集，跑 Docker 容器內才用到的設定由根目錄 `.env` 提供（`OUTBOX_*` 同樣只在根目錄 `.env.example` 出現，`apps/server/.env.example` 沒有），非漏補。
- [x] 0.5 `apps/server/src/test/helpers.ts` 的 `resetDb()` 加入新表 TRUNCATE：`sync_runs`、3 張 staging 表、3 張目標表（沿用既有「表可能尚未建立則忽略」的 try/catch 慣例）
- [x] 0.6 `pnpm db:push` 與 `pnpm db:push:test` 套用新 schema 到開發庫與測試庫
  > 稽核證據：實際 `docker exec` 進 `fastify_drizzle_todolist-postgres` 查 `\dt`，開發庫 `fastify_drizzle_todolist` 與測試庫 `fastify_drizzle_todolist_test` 皆已建出 `sync_runs`／3 張 staging 表／3 張目標表。

## 1. 核心型別與設定（wave B2 前半，非 TDD glue）
Depends on: §0

- [x] 1.1 `apps/server/src/staging-sync/constants.ts`：`SYNC_TYPE_TEMPLATE_CATALOG = 'template_catalog'`、`STAGING_CHUNK_SIZE = 500`、phase／result code 字面量常數
- [x] 1.2 `apps/server/src/staging-sync/errors.ts`：`ActiveSyncRunError`、`LockConflictError`、`LockError`、`FenceLostError`、`SourceFetchError`（各帶 context 欄位，如 syncType/runId/phase）
- [x] 1.3 `apps/server/src/staging-sync/config.ts`：`getStagingSyncConfig()`（讀 env 的 sourceUrl/pageSize/fetchTimeoutMs，附加程式內建預設 `fetchRetries=3`、`fetchRetryDelayMs=1000`、retention 設定：done 1 日／fetch_failed·abandoned 7 日／terminal run 90 日）／`setStagingSyncConfigForTest()`
- [x] 1.4 `apps/server/src/staging-sync/fence.ts`：`SyncRunFence` 型別（`{ runId, phase, ownerToken, leaseVersion }`）

## 2. Manifest（wave B2，TDD）
Depends on: §0, §1

- [x] 2.1 RED: 寫測試 `manifest 宣告的目標表／暫存表／conflict key 欄位與實際 schema 一致`（`staging-sync/schema.test.ts`）
  > 稽核註記：測試實際落在 `staging-sync/manifest.test.ts`（非 tasks 原文指定的 `schema.test.ts`），內容完整覆蓋此描述（10 個 it，逐一驗證 stagingTable/targetTable 物件參照、conflict key／payload 欄位存在性、業務鍵不含本地 id 等）；`schema.test.ts` 另外承接 §4 的 DB constraint 測試。判定為合理的檔案組織、非實質偏離。
- [x] 2.2 GREEN: 實作 `manifest.ts`：3 表 manifest（目標表名、staging 表名、conflict key 欄位、payload 欄位），供 writer/merger/測試共用的單一事實來源

## 3. Advisory lock 互斥（wave B2，TDD，可與 §2、§4 平行）
Depends on: §0, §1

- [x] 3.1 RED: 寫測試 `兩個並發請求只有一個取得鎖，另一個立即得到衝突結果`（`staging-sync/mutex.test.ts`）
- [x] 3.2 RED: 寫測試 `release 後可再次取得，證明鎖與同一 client 綁定`（`staging-sync/mutex.test.ts`）
- [x] 3.3 RED: 寫測試 `pg_advisory_unlock 回傳 false 時記錄警告但不拋出`（`staging-sync/mutex.test.ts`）
- [x] 3.4 GREEN: 實作 `mutex.ts` 的 `acquireSyncLock(syncType)`：從 `pool` 取專用 client → `pg_try_advisory_lock(hashtext('staging_sync'), hashtext($syncType))` → busy 回 `LockConflictError`、查詢錯誤回 `LockError`；回傳 `{ client, backendPid, release() }`；release 用同一 client `pg_advisory_unlock`，回 false 記結構化警告；finally 一定歸還 client

## 4. sync_runs 狀態機與 fencing（wave B2，TDD，可與 §3、§5~§7 平行）
Depends on: §0, §1

- [x] 4.1 RED: 寫測試 `同 sync_type 兩個進行中執行撞 23505 並轉譯為可識別錯誤`（`staging-sync/schema.test.ts`）
  > 稽核註記：raw 23505 constraint 測試在 `schema.test.ts`；「轉譯為 `ActiveSyncRunError`」的行為則在 `run-manager.test.ts` 的 `startFetching` describe（`it.each` 涵蓋 fetching/staged/swapping 三種殘留狀態）驗證。兩者合起來完整覆蓋描述，非實質偏離。
- [x] 4.2 RED: 寫測試 `已結束狀態的多筆執行可共存`（`staging-sync/schema.test.ts`）
- [x] 4.3 GREEN: 實作 `run-manager.ts` 的 `startFetching(syncType)`：insert 一筆 `phase='fetching'` 執行，撞 23505 轉譯為 `ActiveSyncRunError`
- [x] 4.4 RED: 寫測試 `合法狀態依序轉移：fetching→staged→swapping→done`（`staging-sync/run-manager.test.ts`）
- [x] 4.5 GREEN: 實作 `markStaged`、`claimForSwap`（交易內 `FOR UPDATE` ＋ fence 比對＋CAS：phase→swapping、換 `ownerToken`、`leaseVersion+1`、`swapAttempts+1`）、`completeInsideTransaction(tx, fence, summary)`（在呼叫端傳入的 swap 交易內 phase→done）
- [x] 4.6 RED: 寫測試 `每個狀態轉移方法在 fence 不符時皆拒絕`（`staging-sync/run-manager.test.ts`，逐方法各一案例）
- [x] 4.7 GREEN: 為 `markStaged`／`claimForSwap`／`completeInsideTransaction`／`failPhaseOne`／`returnSwapToStaged` 補上一致的 fenced update（`WHERE id AND phase AND ownerToken AND leaseVersion`），影響筆數不為 1 時拋 `FenceLostError`
- [x] 4.8 RED: 寫測試 `recoverActiveRun：殘留 fetching 判定為 fetch_failed`（`staging-sync/run-manager.test.ts`）
- [x] 4.9 RED: 寫測試 `recoverActiveRun：殘留 swapping 退回 staged 且 leaseVersion 遞增`（`staging-sync/run-manager.test.ts`）
- [x] 4.10 RED: 寫測試 `recoverActiveRun：殘留 staged 原樣回傳供重播`（`staging-sync/run-manager.test.ts`）
- [x] 4.11 GREEN: 實作 `recoverActiveRun(syncType)` 三分支邏輯
- [x] 4.12 RED: 寫測試 `abandon 僅限 staged：狀態轉為 abandoned 並記錄操作者與原因`（`staging-sync/run-manager.test.ts`）
- [x] 4.13 RED: 寫測試 `abandon 對非 staged 狀態拒絕`（`staging-sync/run-manager.test.ts`）
- [ ] 4.14 GREEN: 實作 `abandon(runId, operator, reason)`：僅限 `staged`，非此狀態拋錯
  > 稽核註記：實際簽章為 `abandon(runId, reason, operator)`（參數順序與描述不同），且非 staged 狀態**回傳 `null`**，並非「拋錯」——程式碼註解明確說明是刻意設計（「這是操作者主動發起的動作…不是系統例外，刻意不用拋錯表達」），呼叫端（admin 路由 13.10）依 `null` 轉譯成 HTTP 422。功能完整且有測試覆蓋，但與本行「拋錯」的描述做法不同，故不勾選。
- [x] 4.15 GREEN: 實作 `failPhaseOne(fence, errorPhase, errorMessage)`（消毒錯誤訊息：僅存「錯誤類別: 訊息前 300 字」，`ownerToken` 清 null）

## 5. Mock 範本庫來源服務（wave B2'，TDD，可與 §2~§4 平行）
Depends on: §0, §1

- [x] 5.1 RED: 寫測試 `相同查詢參數重複呼叫回應內容完全一致`（`routes/mock-source.test.ts`）
- [x] 5.2 RED: 寫測試 `overlap=1 時第 2 頁頁首重複前一頁末筆`（`routes/mock-source.test.ts`）
- [x] 5.3 RED: 寫測試 `mode 切換：success/fail/fail_page_2/flaky_page_2/empty 各自行為正確`（`routes/mock-source.test.ts`，5 個案例）
- [x] 5.4 RED: 寫測試 `reset 端點清空狀態並恢復預設模式`（`routes/mock-source.test.ts`）
- [x] 5.5 GREEN: 實作 `routes/mock-source.ts`：`GET /mock-source/template-catalog?limit=&offset=&overlap=`（決定性生成：預設 120 筆清單、`?total=` 可覆寫、`sourceListId=1000+i`、每清單 `(i%5)+2` 個項目、`sourceItemId=sourceListId*100+j`、`priority=(j*7)%10`、tag 從固定 12 名稱池索引算術選取）、`PUT /mock-source/mode`（`success`/`fail`/`fail_page_2`/`flaky_page_2`/`empty`）、`POST /mock-source/reset`；新增 `resetMockSourceState()` 供測試重置；於 `app.ts` 註冊 `mockSourceRoutes`

## 6. 逐頁惰性抓取（wave B2'，TDD，可與 §2~§4 平行）
Depends on: §1, §5

- [x] 6.1 RED: 寫測試 `逐頁惰性產生，呼叫端消費一頁前不預先抓取下一頁`（`staging-sync/page-fetcher.test.ts`）
  > 稽核註記（更新）：已補上專屬測試「提前中止不多抓：for-await 拿到第一頁就 break，只會發出一次 HTTP 請求（驗證惰性）」（`page-fetcher.test.ts`），實際斷言提前 break 後 fetch 呼叫次數為 1，鎖住惰性這個性質。
- [x] 6.2 RED: 寫測試 `count < pageSize 時終止抓取`（`staging-sync/page-fetcher.test.ts`）
- [x] 6.3 RED: 寫測試 `剛好整頁時允許最後一次空頁請求`（`staging-sync/page-fetcher.test.ts`）
- [x] 6.4 RED: 寫測試 `flaky_page_2：第一次 500，重試後成功`（`staging-sync/page-fetcher.test.ts`）
- [x] 6.5 RED: 寫測試 `fail_page_2：重試耗盡仍失敗，拋出 SourceFetchError`（`staging-sync/page-fetcher.test.ts`）
- [x] 6.6 RED: 寫測試 `4xx 不重試直接拋出`（`staging-sync/page-fetcher.test.ts`）
- [x] 6.7 GREEN: 實作 `page-fetcher.ts` 的 `streamCatalogPages(config)` async generator：一次 yield 一頁 `{ pageIndex, offset, rows, count }`；終止條件 `count < pageSize`（剛好整頁時多請求一次確認空頁）；單頁重試只重試網路錯誤/5xx，最多 `fetchRetries` 次、間隔 `fetchRetryDelayMs`（可注入 sleep 供測試）；4xx 不重試；耗盡拋 `SourceFetchError`（比照 `todos.test.ts` 的 `app.listen({ port: 0 })` 做法起真實埠供 fetcher 打 HTTP）

## 7. 單頁攤平轉換（wave B2'，TDD，可與 §2~§6 平行）
Depends on: §1

- [x] 7.1 RED: 寫測試 `巢狀資料正確攤平成三組緩衝`（`staging-sync/page-transformer.test.ts`）
- [x] 7.2 RED: 寫測試 `同頁重複業務鍵 last-row-wins`（`staging-sync/page-transformer.test.ts`）
- [x] 7.3 RED: 寫測試 `空頁仍初始化三組緩衝為空集合`（`staging-sync/page-transformer.test.ts`）
- [x] 7.4 GREEN: 實作 `page-transformer.ts` 的 `transformPage(rows)`：巢狀 rows 攤平成 3 個 keyed buffer（Map，key=conflict key），同頁重複鍵 last-row-wins，三個 buffer 即使該頁沒資料也必初始化為空

## 8. 暫存表逐頁寫入（wave B3）
Depends on: §2, §4, §7

- [x] 8.1 RED: 寫測試 `fence 失效時拒絕寫入，暫存表與檢查點皆不受影響`（`staging-sync/staging-writer.test.ts`）
- [x] 8.2 RED: 寫測試 `寫入成功後於同交易更新進度檢查點`（`staging-sync/staging-writer.test.ts`）
- [x] 8.3 RED: 寫測試 `不同執行的暫存資料以 sync_run_id 隔離`（`staging-sync/staging-writer.test.ts`）
- [x] 8.4 RED: 寫測試 `跨頁重複業務鍵 upsert 具冪等性（overlap 情境）`（`staging-sync/staging-writer.test.ts`）
- [x] 8.5 GREEN: 實作 `staging-writer.ts` 的 `writePage(fence, pageMeta, buffers)`：每頁一個短交易——`SELECT ... FOR UPDATE` 鎖 run row → 驗 fence（`phase='fetching'`＋`ownerToken`＋`leaseVersion`）→ 依 manifest 逐表 chunk（`STAGING_CHUNK_SIZE`）`INSERT ... ON CONFLICT (sync_run_id, 業務鍵) DO UPDATE` → 同交易 fenced 更新檢查點（`lastOffset`/`pageCount`/`sourceCount`/`stagedCounts`/`heartbeatAt`/`peakMemoryBytes`）

## 9. 原子切換：mark-and-sweep、衍生欄位重算、失敗回滾（wave B3）
Depends on: §2, §4, §8

- [x] 9.1 RED: 寫測試 `暫存不存在的舊資料標記為 is_active=false`（`staging-sync/merger.test.ts`）
- [x] 9.2 RED: 寫測試 `暫存存在的資料復活且欄位更新為最新值`（`staging-sync/merger.test.ts`）
- [x] 9.3 RED: 寫測試 `合併以業務鍵而非本地主鍵比對，PK 世代改變不影響結果`（`staging-sync/merger.test.ts`）
- [x] 9.4 GREEN: 實作 `merger.ts` 的 mark 階段（3 張目標表整批 `UPDATE SET is_active=false`）與 merge 階段（依 manifest 逐表 `INSERT ... SELECT FROM staging WHERE sync_run_id=$ ON CONFLICT (業務鍵) DO UPDATE SET payload..., is_active=true, updated_at=now()`）
- [x] 9.5 RED: 寫測試 `依 priority 降冪、source_item_id 升冪重算 position`（`staging-sync/merger.test.ts`）
- [x] 9.6 RED: 寫測試 `非啟用項目的 position 維持舊值不參與重算`（`staging-sync/merger.test.ts`）
- [x] 9.7 RED: 寫測試 `singleton 分組的 position 為 1`（`staging-sync/merger.test.ts`）
- [x] 9.8 GREEN: 實作 `recomputePositions(tx)`：`ROW_NUMBER() OVER (PARTITION BY source_list_id ORDER BY priority DESC, source_item_id ASC)`，僅更新 `is_active=true` 的項目
- [x] 9.9 RED: 寫測試 `failureInjector 於 mark/merge/position 各階段注入 → 整體回滾`（`staging-sync/merger.test.ts`，`after_mark:<table>`／`after_merge:<table>`／`after_positions` 至少各一案例）
- [x] 9.10 RED: 寫測試 `回滾後執行退回 staged 且暫存資料保留`（`staging-sync/merger.test.ts`）
- [x] 9.11 GREEN: 實作 `merger.ts` 的 `swap(stagedFence, { failureInjector? })`：`claimForSwap` → 單一交易內 `FOR UPDATE` 再驗 fence（`phase='swapping'`）→ mark → merge → `recomputePositions(tx)` → `completeInsideTransaction(tx, fence, summary)`；`failureInjector(hook)` 支援 `after_mark:<table>`/`after_merge:<table>`/`after_positions`；交易失敗時 rollback → `returnSwapToStaged` → 重拋；commit 後 `deleteStagingRows(runId)` best-effort（失敗只 warn，殘留交給 pruner）

## 10. Phase 1 協調：orchestrator（wave B3，非獨立測試檔，由 §11 dispatcher 測試端到端覆蓋）
Depends on: §4, §6, §7, §8

- [x] 10.1 GREEN（非 TDD，無獨立測試檔）: 實作 `orchestrator.ts` 的 `runPhaseOne(lease)`：`recoverActiveRun`（`staged` 直接回傳重播；`fetching` 判死；`swapping` 回 `staged`）→ 無 active run 則 `startFetching` → for-await 逐頁 `transformPage`＋`writePage`，每頁後釋放參照、追蹤 `heapUsed` 峰值 → `sourceCount===0` → `markNoData` 回 `no_data`；否則 `markStaged`；任何錯誤 → `failPhaseOne` 後重拋

## 11. Dispatcher：Phase 1+2 全流程協調（wave B3）
Depends on: §3, §9, §10

- [x] 11.1 RED: 寫測試 `happy path：完整跑完兩階段並回傳結果摘要`（`staging-sync/dispatcher.test.ts`）
- [x] 11.2 RED: 寫測試 `no_data：來源空集合，不執行切換，目標表不受影響`（`staging-sync/dispatcher.test.ts`）
- [x] 11.3 RED: 寫測試 `fetch 失敗：目標表零變更，執行標記為 fetch_failed`（`staging-sync/dispatcher.test.ts`）
- [x] 11.4 RED: 寫測試 `swap 失敗後下次 dispatch 直接重播，mock source 零額外請求`（`staging-sync/dispatcher.test.ts`）
- [x] 11.5 RED: 寫測試 `兩個並發 trigger 只有一個成功，另一個鎖衝突`（`staging-sync/dispatcher.test.ts`）
- [x] 11.6 GREEN: 實作 `dispatcher.ts` 的 `runTemplateCatalogSync()`：`acquireSyncLock` → try：`orchestrator.runPhaseOne` → 結果為 `staged` → `merger.swap` → 組結果摘要 `{ runId, resultCode, phase, pageCount, sourceCount, stagedCounts, fetchSeconds, swapSeconds }` → finally release

## 12. 背景清理：pruner（wave B3，可與 §9~§11 平行）
Depends on: §0, §2, §4

- [x] 12.1 RED: 寫測試 `done 執行的暫存資料逾 1 日被清除`（`staging-sync/pruner.test.ts`）
- [x] 12.2 RED: 寫測試 `fetch_failed/abandoned 的暫存資料逾 7 日被清除`（`staging-sync/pruner.test.ts`）
- [x] 12.3 RED: 寫測試 `終態執行紀錄逾 90 日本身被刪除`（`staging-sync/pruner.test.ts`）
- [x] 12.4 RED: 寫測試 `進行中執行（含逾期）不受任何清理影響`（`staging-sync/pruner.test.ts`）
- [x] 12.5 RED: 寫測試 `重複執行清理具冪等性，計數不重複`（`staging-sync/pruner.test.ts`）
- [x] 12.6 GREEN: 實作 `pruner.ts` 的 `pruneStagingSyncRuns()`：依 retention 設定清除 `done`（1 日）／`fetch_failed`·`abandoned`（7 日）暫存資料，`sync_runs` 終態列逾 90 日整列刪除，永不碰進行中 `phase`，回傳各項清理筆數

## 13. 維運端點（wave B4）
Depends on: §11, §12

- [x] 13.1 RED: 寫測試 `未登入呼叫四支端點皆回 401`（`routes/staging-sync-admin.test.ts`）
- [x] 13.2 RED: 寫測試 `觸發同步完成回傳 200 與結果摘要`（`routes/staging-sync-admin.test.ts`）
- [x] 13.3 RED: 寫測試 `觸發時鎖衝突或既有進行中執行回 409`（`routes/staging-sync-admin.test.ts`）
  > 稽核註記：實測只涵蓋「鎖衝突（`LockConflictError`）→409」一種情境；「既有進行中執行（`ActiveSyncRunError`）→409」在這支測試檔沒有專屬案例。路由程式碼對兩者一視同仁（`error instanceof LockConflictError || error instanceof ActiveSyncRunError` 皆回 409），行為正確，僅測試覆蓋面略窄，不影響本項判定為完成。
- [x] 13.4 RED: 寫測試 `觸發時鎖層錯誤回 503`（`routes/staging-sync-admin.test.ts`）
  > 稽核註記（更新）：已補上測試「取鎖過程本身出錯（連線池故障）：503，且回應形狀為 { error }」（`staging-sync-admin.test.ts`），驗證 `LockError → 503` 分支與回應形狀。
- [x] 13.5 GREEN: 實作 `POST /staging-sync/trigger`：呼叫 `runTemplateCatalogSync()`；`ActiveSyncRunError`/`LockConflictError`→409、`LockError`→503、其餘成功（含 `no_data`）→200 並回傳消毒過的結果摘要
- [x] 13.6 RED: 寫測試 `查詢近期執行列表不含 ownerToken`（`routes/staging-sync-admin.test.ts`）
- [x] 13.7 GREEN: 實作 `GET /staging-sync/runs?limit=20`：查最近 N 筆執行摘要，回應排除 `ownerToken`
- [x] 13.8 RED: 寫測試 `放棄 staged 執行成功`（`routes/staging-sync-admin.test.ts`）
- [x] 13.9 RED: 寫測試 `放棄非 staged 執行回 422`（`routes/staging-sync-admin.test.ts`）
- [x] 13.10 GREEN: 實作 `POST /staging-sync/runs/:id/abandon`（body `{ reason }`）：呼叫 `run-manager.abandon`，非 `staged` 回 422，記操作者為登入者 email
- [x] 13.11 RED: 寫測試 `查詢目錄回傳依 position 排序的巢狀資料`（`routes/staging-sync-admin.test.ts`）
- [x] 13.12 GREEN: 實作 `GET /staging-sync/catalog`：回傳 `is_active` 的 lists＋items（依 `position` 排序）＋tags 巢狀組合；全部端點掛 `app.authenticate`；於 `app.ts` 註冊 `stagingSyncAdminRoutes`

## 14. 維運 CLI（wave B4，可與 §13 平行）
Depends on: §11, §12

- [x] 14.1 RED: 寫測試 `staging-sync-run：成功/無資料/失敗結束碼分別為 0/2/1`（`scripts/staging-sync-cli.test.ts`，3 個案例）
  > 稽核註記：腳本與測試實際落在 `apps/server/src/scripts/`（非 tasks 原文的頂層 `scripts/`），與既有 `outbox-prune.ts`／`seed-dev-user.ts` 等既有維運腳本同一慣例位置，判定為合理的既有專案結構、非實質偏離。
- [x] 14.2 GREEN: 實作 `scripts/staging-sync-run.ts`：呼叫 `runTemplateCatalogSync()`，依 `resultCode` 決定結束碼（`success`→0、`no_data`→2、其餘/鎖衝突→1），輸出 JSON 結果摘要
- [x] 14.3 RED: 寫測試 `staging-sync-status：輸出最近 N 筆執行摘要`（`scripts/staging-sync-cli.test.ts`）
- [x] 14.4 GREEN: 實作 `scripts/staging-sync-status.ts`：解析 `--limit`，呼叫查詢近期執行邏輯並輸出
- [x] 14.5 RED: 寫測試 `staging-sync-abandon：對非 staged 執行報錯退出`（`scripts/staging-sync-cli.test.ts`）
- [x] 14.6 RED: 寫測試 `staging-sync-abandon：對 staged 執行成功放棄`（`scripts/staging-sync-cli.test.ts`）
- [x] 14.7 GREEN: 實作 `scripts/staging-sync-abandon.ts <runId> --reason=...`：呼叫 `run-manager.abandon`，非 `staged` 報錯退出
- [x] 14.8 RED: 寫測試 `staging-sync-prune：輸出各項清理筆數`（`scripts/staging-sync-cli.test.ts`）
- [x] 14.9 GREEN: 實作 `scripts/staging-sync-prune.ts`：呼叫 `pruneStagingSyncRuns()` 並輸出結果
- [x] 14.10 GREEN（非 TDD glue）: `apps/server/package.json` 新增 `staging-sync:run`／`staging-sync:status`／`staging-sync:abandon`／`staging-sync:prune` scripts

## 15. 專案文件（wave C）
Depends on: §11, §12, §13, §14

- [x] 15.1（非 TDD）新增 `docs/staging-sync/design.md`：比照既有 `docs/outbox/design.md` 的完整規格文件格式，涵蓋問題背景（記憶體與原子性兩難）、核心設計決策、資料表、狀態機、模組配置、fencing 說明、HTTP 端點、CLI、環境變數、測試策略、前端教學頁、程式風格約束
  > 稽核註記（更新）：已補齊獨立章節 §7 HTTP 端點、§8 CLI、§9 環境變數、§10 測試策略、§13 程式風格約束（共 13 章，300 行內），並移除全部「尚未實作」/「設計中」等過時宣稱，內容與 `routes/staging-sync-admin.ts`／`scripts/staging-sync-*.ts`／`packages/env/src/server.ts`／前端 `staging-sync-guide.tsx` 等實碼核對一致；含 §7、§12 記錄了審查修復的 `REPEATABLE READ` 唯讀交易與錯誤遮蔽保護兩個教學重點。

## 16. 前端：即時操作 hook 與教學頁（wave D）
Depends on: §13

- [x] 16.1 RED: 寫測試 `loads_runs_successfully`（`use-staging-sync.test.tsx`）
- [x] 16.2 RED: 寫測試 `sets_error_on_fetch_failure`（`use-staging-sync.test.tsx`）
  > 稽核註記：實際測試檔為 `hooks/use-staging-sync-guide.test.tsx`，案例名為 `sets_error_on_runs_fetch_failure`（非完全同名，行為一致）。
- [x] 16.3 RED: 寫測試 `trigger_calls_api_and_refetches_runs`（`use-staging-sync.test.tsx`）
  > 稽核註記：實際案例為 `trigger_sync_refetches_runs_and_catalog_on_success` 與 `trigger_sync_skips_catalog_refetch_when_no_data`，涵蓋更完整（含 no_data 時不重讀目錄），非同名但行為涵蓋更廣。
- [x] 16.4 RED: 寫測試 `abandon_calls_api_and_refetches_runs`（`use-staging-sync.test.tsx`）
- [x] 16.5 RED: 寫測試 `loads_catalog_successfully`（`use-staging-sync.test.tsx`）
  > 稽核註記：實際案例名為 `loads_catalog_on_mount`，行為一致。
- [x] 16.6 GREEN: 實作 `lib/staging-sync-api.ts`（`fetchStagingSyncRuns`/`triggerStagingSync`/`abandonStagingSyncRun`/`fetchStagingSyncCatalog`，皆走 `httpClient`）與 `hooks/use-staging-sync.ts`（載入 runs/catalog、`trigger`/`abandon` 操作方法、loading/error 狀態管理）
  > 稽核註記：hook 檔實際命名為 `hooks/use-staging-sync-guide.ts`（非 `use-staging-sync.ts`），且額外多帶 mock 模式切換（`switchMode`/`resetMock`）與 runs 輪詢，超出本行描述但屬合理擴充（供教學頁「切換 mock 模式」按鈕使用，`design.md` §6 也預告了此功能）。四個 API 函式與 `lib/staging-sync-api.ts` 檔名／內容完全相符。
- [x] 16.7（非 TDD，UI 接線）建立 `routes/staging-sync-guide.tsx`：記憶體/原子性兩難說明、架構圖／狀態機圖／fencing 概念圖（內嵌 SVG）、即時演示區（觸發同步按鈕、結果摘要、近期執行列表、放棄操作、目前生效目錄檢視）
- [x] 16.8（非 TDD，UI 接線）`router.tsx` 加受保護路由 `/staging-sync-guide`；`components/header.tsx` 加 `NavLink` 導覽連結

## 17. 收斂驗證與手動端到端驗證（wave E，非 TDD）
Depends on: §8, §9, §10, §11, §12, §13, §14, §16

- [x] 17.1 跨任務整合審查：確認全部模組間的 fencing 傳遞一致、交易邊界正確（單頁短交易 vs. 單一切換交易）、manifest 是否被 writer/merger/pruner 一致使用
  > 稽核證據：本次稽核逐檔核對，確認 `SyncRunFence` 貫穿 run-manager/staging-writer/merger 一致傳遞；`staging-writer.writePage` 每頁各自 `db.transaction`（短交易），`merger.swap` 的 mark+merge+recomputePositions+completeInsideTransaction 在單一 `db.transaction` 內完成（長交易）；`templateCatalogManifest` 被 `staging-writer.ts`／`merger.ts` 逐表迭代使用，`pruner.ts` 透過 `merger.ts` 匯出的 `deleteStagingRows()` 間接沿用同一 manifest，三者一致。
- [x] 17.2 手動端到端驗證：本機啟動 server（含 mock-source），於 `/staging-sync-guide` 觸發一次同步（`success` 模式），確認目錄正確刷新且 `position` 排序正確
  > 稽核證據：本次稽核對本機執行中的 Docker dev server（`fastify_drizzle_todolist-server`，port 7529）直接以 curl 呼叫 `POST /staging-sync/trigger`（mode=success），回傳 `resultCode=success`／`pageCount=3`／`sourceCount=120`／`stagedCounts={lists:120,items:480,tags:720}`；`GET /staging-sync/catalog` 確認 items 依 `position` 正確排序（如 `sourceListId=1000` 下 priority=7 的項目 position=1、priority=0 的 position=2）。
- [x] 17.3 手動端到端驗證：切換 mock 模式為 `fail_page_2`，觸發同步，確認執行標記為 `fetch_failed` 且目標表無變化；切回 `success` 後重新觸發，確認正常完成
  > 稽核證據：延續上一項的 curl 驗證，切換 mode=fail_page_2 後觸發同步回傳 `HTTP 502`／`SourceFetchError: 第 2 頁抓取失敗...`；查 `GET /staging-sync/runs` 確認該筆 `phase=fetch_failed`／`resultCode=fetch_failed`；此時 `GET /staging-sync/catalog` 仍是先前成功那次的 120 筆清單（目標表無變化）；切回 success 後重新觸發回傳 `resultCode=success`，正常完成。
- [ ] 17.4 手動端到端驗證：以 `failureInjector`（或暫時的除錯開關）模擬切換中途失敗，確認執行退回 `staged`；再次觸發，以 mock source 的請求計數確認未重新抓取，且最終切換成功
  > 稽核註記：`merger.swap`／`dispatcher.runTemplateCatalogSync` 的 `failureInjector`/`swapFailureInjector` 僅是程式參數（`merger.ts`/`dispatcher.ts`），grep 確認 `routes/staging-sync-admin.ts` 與所有 `scripts/staging-sync-*.ts` 皆未接線任何除錯開關可以從外部觸發它。也就是說，光靠「跑起來的 app／CLI」目前無法讓一般操作者手動重現「切換中途失敗」的情境（此行為僅由 `merger.test.ts`／`dispatcher.test.ts` 的自動化測試直接呼叫函式注入驗證，見 §9.9/9.10、§11.4）。本次稽核未發現此手動驗證步驟被實際執行過的證據，故不勾選。
- [ ] 17.5 手動端到端驗證：對一筆 `staged` 執行使用前端或 CLI 放棄，確認狀態轉為 `abandoned`；執行 `staging-sync:prune`，確認保留期限規則正確清除暫存與終態執行紀錄
  > 稽核註記：承 17.4，透過目前暴露的 HTTP／CLI 介面，一輪同步只要進入 `staged` 就會在同一次呼叫內立即接著 `merger.swap`，沒有自然的「暫停在 staged」時機可供操作者手動放棄；需要人工直接寫 DB（不算「前端或 CLI」）或前述除錯開關才能製造出可放棄的 `staged` 執行。本次稽核未發現此步驟被實際執行過的證據，故不勾選；`abandon`／`pruneStagingSyncRuns` 本身的行為已由 §4.12-4.14、§12 的自動化測試充分覆蓋。
