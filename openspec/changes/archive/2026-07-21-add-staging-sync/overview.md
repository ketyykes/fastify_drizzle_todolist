# Overview: add-staging-sync

<!--
  ASCII 人類版摘要。所有圖包在三引號程式碼區塊內。
  框內盡量用英文標籤以維持等寬對齊；中文註解放框外，用 ← 對齊。
  程式碼區塊內一律使用半形括號與半形方括號，不使用全形符號破壞框線對齊。
-->

## Scope

在既有 todolist（登入 + per-user todos CRUD）與 `transactional-outbox` 教學情境之上，加一個獨立的新教學情境：從 mock 範本庫（template catalog）服務分頁拉取巢狀資料，以「逐頁抓取 → staging 暫存表 → 單一交易原子切換」的治本模式全量刷新本地目錄，同時示範 `sync_runs` 狀態機、advisory lock 互斥、owner_token/lease_version fencing、背景清理、維運端點與 CLI，以及一個可即時操作觀察的前端教學頁。

**Size**: large — 依 schema「取最大命中」，本 change 的 tasks.md 有 112 個 checkbox（遠超 large 門檻的 tasks > 20），故判定為 large。實作橫跨 DB schema（2 個新檔、1 個 enum、7 張新表）、後端新模組（`staging-sync/` 14 個檔案）、mock 來源路由、維運路由、4 支 CLI，以及前端新頁面／hook／API 封裝，對外新增 1 個 capability（`staging-sync`）。
**Frontend involved**: yes — `/staging-sync-guide` 頁面含觸發同步、觀察執行歷程、放棄 staged 執行、瀏覽目前生效目錄等互動與對應的載入/錯誤狀態，故含 UI Mockups 區塊。

---

## What Changes

- 新增 3 張目標表（`template_lists`/`template_items`/`template_item_tags`）與 `sync_runs` 狀態機表（含 partial unique index）＋ 3 張 staging 表。
- 新增 `apps/server/src/staging-sync/` 模組：逐頁抓取、單頁攤平、暫存表寫入、advisory lock 互斥、狀態機與 fencing、原子切換（mark-and-sweep＋衍生欄位重算）、Phase 1+2 協調、背景清理。
- 新增無認證的 mock 範本庫來源（`routes/mock-source.ts`，決定性生成＋overlap 模擬分頁漂移＋多種故障模式）。
- 新增需登入的維運端點（觸發／查詢執行／放棄／查詢目錄）與 4 支維運 CLI。
- 新增前端 `/staging-sync-guide` 教學頁：記憶體/原子性兩難說明、架構圖、狀態機圖、fencing 概念圖、即時操作區。

目前狀態與變更後的對照：

```
=== Before ===
catalog : 無此概念，本地無範本目錄資料表
sync    : 無大量外部資料同步機制
ops     : 無 staging-sync 相關端點/CLI
web     : 無 staging-sync 相關頁面

=== After ===
catalog : template_lists/template_items/template_item_tags 三張目標表
sync    : 逐頁抓取 -> staging 暫存表 -> 單一交易原子切換刷新目標表
ops     : GET/POST /staging-sync/* 端點 + 4 支 staging-sync:* CLI
web     : /staging-sync-guide 頁面，可觸發/觀察/放棄同步、瀏覽目錄
```

---

## UI Mockups

`/staging-sync-guide` 是既有 header 新增的一個受保護頁籤，聚焦在「即時演示區」（其餘為靜態說明區塊：記憶體/原子性兩難、架構圖、狀態機圖、fencing 概念說明，內容固定不隨操作變化）。以下畫出即時演示區的幾個關鍵 state。

```
=== State 1: 進入頁面，讀取中 (loading) ===

+----------------------------------------+
| Todo App  alice [Todos][Outbox][Staging]| <- header 新增 Staging Sync 頁籤
+----------------------------------------+
| Staging Sync 教學                        |
| [static: 兩難說明/架構圖/狀態機/fencing]   |
|                                          |
| 5. 即時演示區                             |
| [Trigger Sync]                          | <- Skeleton 載入中
| runs: ...   catalog: ...                |
+----------------------------------------+

=== State 2: 讀取完成，尚無任何執行 (loaded, empty) ===

| [Trigger Sync]                          |
|                                          |
| 近期執行： (無資料)                        |
| 目前生效目錄： (無資料)                     |
+----------------------------------------+
              |
              | 點 [Trigger Sync]
              v

=== State 3: 觸發中 (triggering) ===

| [Trigger Sync (spinner)] disabled       | <- 按鈕顯示 loading 圖示且禁用
+----------------------------------------+
              |
              | mock source 為 success 模式，同步成功完成
              v

=== State 4: 觸發成功 (done) ===

| [Trigger Sync]                          |
| 結果摘要: resultCode=success             |
|   pageCount=3 sourceCount=120           |
|   staged={lists:120,items:312,tags:480} |
|                                          |
| 近期執行：                                |
|  id=1 template_catalog done  0.8s       |
|                                          |
| 目前生效目錄：                             |
|  清單A (2項) / 清單B (3項) ...           |
+----------------------------------------+
              |
              | 切 mock 模式為 fail_page_2，再次 [Trigger Sync]
              v

=== State 5: 觸發失敗 (fetch_failed，目標表零變更) ===

| [Trigger Sync]                          |
| 結果摘要: 觸發失敗(抓取階段錯誤)             | <- 紅字錯誤提示
|                                          |
| 近期執行：                                |
|  id=2 template_catalog fetch_failed     |
|  id=1 template_catalog done      0.8s   |
|                                          |
| 目前生效目錄： (與 State 4 相同，未變更)     |
+----------------------------------------+
              |
              | 模擬切換中途失敗(產生一筆 staged 執行)
              v

=== State 6: 有一筆 staged 待放棄的執行 ===

| 近期執行：                                |
|  id=3 template_catalog staged           |
|    [Abandon] [reason: __________]       | <- 僅 staged 列顯示放棄操作
|  id=2 template_catalog fetch_failed     |
|  id=1 template_catalog done      0.8s   |
+----------------------------------------+
              |
              | 輸入原因並點 [Abandon]
              v

=== State 7: 放棄完成，列表重新整理 ===

| 近期執行：                                |
|  id=3 template_catalog abandoned        |
|  id=2 template_catalog fetch_failed     |
|  id=1 template_catalog done      0.8s   |
| toast: 已放棄執行 #3                     |
+----------------------------------------+

=== State 8: 執行列表讀取失敗 (error，不阻擋其餘區塊) ===

| 近期執行讀取失敗: Network Error           | <- 紅字錯誤提示
| [Trigger Sync] 仍可點擊                  | <- 其餘操作不因此鎖死整頁
+----------------------------------------+
```

---

## Architecture

正常路徑：維運端點或 CLI 觸發 `dispatcher.runTemplateCatalogSync()` → 取得 advisory lock → Phase 1（逐頁抓取＋攤平＋寫暫存表，每頁一個短交易）→ Phase 2（單一交易原子切換：mark-and-sweep＋衍生欄位重算）→ 釋放鎖。失敗兜底：抓取失敗目標表零變更；切換失敗回滾並退回 `staged`，下次觸發直接重播不重新抓取。

```
+----------------------------------------------------+
| server (Fastify)                                    |
|                                                       |
| POST /staging-sync/trigger [需登入]                    |
|  -> dispatcher.runTemplateCatalogSync()              |
|     1. acquireSyncLock(syncType)   [advisory lock]   |
|     2. orchestrator.runPhaseOne(lease)               |
|          page-fetcher -> page-transformer            |
|          -> staging-writer (每頁一個短交易)             |
|     3. merger.swap(stagedFence)                      |
|          單一交易: mark -> merge -> recompute position |
|          -> completeInsideTransaction                |
|     4. release lock (finally)                        |
|                                                       |
| sync_runs                     [狀態機 + fencing]       |
| template_lists / template_items / template_item_tags |
| *_staging (3 張暫存表)                                 |
|                                                       |
| GET  /staging-sync/runs                              |
| GET  /staging-sync/catalog                           |
| POST /staging-sync/runs/:id/abandon    [需登入]        |
|                                                       |
| CLI: staging-sync-run / status / abandon / prune     |
+----------------------+--------------------------------+
                       | fetch pages via HTTP (fetcher)
                       v
+------------------------------------------------+
| mock-source 路由 [無認證，模擬第三方範本庫]           |
|  決定性生成 + overlap 模擬分頁漂移                   |
|  mode: success / fail / fail_page_2 /              |
|        flaky_page_2 / empty                        |
+------------------------------------------------+

+------------------------------------------------+
| web /staging-sync-guide [受保護路由]                |
|  useStagingSync: 觸發同步、查詢 runs/catalog、       |
|  放棄 staged 執行                                   |
+------------------------------------------------+
```

---

## Task Tree

tasks.md 各群組的依賴關係（`Depends on:` 為現成標註），依 execution-plan.md 的 waves 排列：B1 基礎建設 → B2（核心層）與 B2'（mock 來源／抓取／轉換，與 B2 平行）→ B3（寫入與協調層）→ B4（維運介面）→ C（文件）與 D（前端，兩者可平行）→ E（收斂驗證）。

```
0. 前置基礎建設 (schema/pool/env/resetDb)                    [B1]
├── 1. 核心型別與設定 (constants/errors/config/fence)         [B2]
│   ├── 2. Manifest                                          [B2]
│   ├── 3. Advisory lock 互斥 (mutex)                         [B2]
│   ├── 4. sync_runs 狀態機與 fencing (run-manager)            [B2]
│   ├── 5. Mock 範本庫來源 (mock-source)                       [B2', 可與 1~4 平行]
│   │   └── 6. 逐頁惰性抓取 (page-fetcher)                     [B2']
│   └── 7. 單頁攤平轉換 (page-transformer)                     [B2', 可與 1~6 平行]
│
├── 8. 暫存表逐頁寫入 (staging-writer)     depends 2,4,7        [B3]
├── 9. 原子切換 (merger)                  depends 2,4,8         [B3]
├── 10. Phase 1 協調 (orchestrator)       depends 4,6,7,8        [B3]
├── 11. Dispatcher                       depends 3,9,10         [B3]
├── 12. 背景清理 (pruner)                 depends 0,2,4          [B3, 可與 9~11 平行]
│
├── 13. 維運端點                          depends 11,12          [B4]
├── 14. 維運 CLI                         depends 11,12          [B4, 可與 13 平行]
│
├── 15. 專案文件                          depends 11,12,13,14    [C]
├── 16. 前端 hook 與教學頁                depends 13              [D, 可與 15 平行]
│
└── 17. 收斂驗證與手動端到端驗證           depends 8~14,16         [E]
```

---

## Cross-Cutting Impact

受影響的檔案／模組矩陣（由 proposal.md 的 Impact 段整理）。

| 檔案 / 模組 | 變更類型 | 風險 |
|-------------|----------|------|
| `packages/db/src/schema/template-catalog.ts` | new（3 張目標表） | low |
| `packages/db/src/schema/staging-sync.ts` | new（1 pgEnum、`sync_runs`＋partial unique index、3 張 staging 表） | medium |
| `packages/db/src/schema/index.ts` | modify（匯出新 schema） | low |
| `packages/db/src/index.ts` | modify（匯出 pg pool） | low |
| `packages/env/src/server.ts` | modify（3 個 `STAGING_SYNC_*` 變數） | low |
| `.env.example`（根／server 兩份） | modify | low |
| `apps/server/src/staging-sync/*.ts`（14 模組 + 對應測試） | new | high |
| `apps/server/src/routes/mock-source.ts` | new | low |
| `apps/server/src/routes/staging-sync-admin.ts` | new | medium |
| `apps/server/src/scripts/staging-sync-*.ts`（4 支 + 測試） | new | low |
| `apps/server/src/app.ts` | modify（註冊新路由群組） | low |
| `apps/server/src/test/helpers.ts` | modify（`resetDb` 加新表） | low |
| `apps/server/package.json` | modify（新增 4 個 CLI scripts） | low |
| `docs/staging-sync/design.md` | new（比照 `docs/outbox/design.md`） | low |
| `apps/web/src/lib/staging-sync-api.ts` | new | low |
| `apps/web/src/hooks/use-staging-sync.ts`（+ 測試） | new | medium |
| `apps/web/src/routes/staging-sync-guide.tsx` | new | medium |
| `apps/web/src/router.tsx` | modify（受保護路由） | low |
| `apps/web/src/components/header.tsx` | modify（導覽連結） | low |
