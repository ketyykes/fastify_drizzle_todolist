# Staging Sync 教學範例 — 設計文件

> 本文件是本專案「暫存表＋原子切換（staging + atomic swap）模式」教學範例的設計依據。模式源自
> 一類真實系統反覆出現的問題：定期把一份**大量、巢狀**的外部資料**全量刷新**進本地資料庫，去
> 識別化後以「mock 範本庫（template catalog provider）」情境重現：mock 服務以分頁回傳「範本
> 清單 → 項目 → 標籤」，本地定期整批同步，過程中衍生欄位（排序位置）要重新計算。
>
> **目前實作狀態**：schema、mock 來源 API、advisory lock、`sync_runs` 狀態機、逐頁抓取與單頁
> 轉換（`page-fetcher.ts`／`page-transformer.ts`）、staging 寫入（`staging-writer.ts`）、原子
> 切換（`merger.ts`）、retention 清理（`pruner.ts`）已完成；`orchestrator.ts`／`dispatcher.ts`、
> 維運端點、CLI、前端教學頁尚未實作，本文件描述其設計契約作為下一步落地依據。

## 1. 要解決的問題（分批的是記憶體，不是 commit）

「一次抓完所有分頁、全部載入記憶體再處理」和「每抓完一頁就對目標表 commit 一次」，是全量同步
最常見的兩種天真做法，各自踩到不同的坑：

- **全部載入記憶體**：process 記憶體用量與來源總筆數成正比，資料量夠大就一定 OOM，且無法優雅
  降級——沒有「處理到一半」，只有「成功」或「整個 process 被殺掉」。
- **天真分批 commit**：每抓完一頁就 commit，記憶體用量封頂在單頁大小沒錯，但把天生需要原子性
  的「全量刷新」切成多筆獨立交易。若刷新邏輯是先標記舊資料過期、再逐頁 upsert 新資料，任何一頁
  中途失敗，目標表就停在「已 mark、還沒完全 sweep 回來」的不一致狀態——使用者看到的是「資料被
  刪掉一半」的假象，且沒有簡單方法退回刷新前的樣子。

**核心原則，貫穿本範例全部設計：分批的是記憶體，不是 commit。**

Staging 暫存表把「封頂記憶體」與「保住原子性」解耦：抓取階段可無限逐頁、每頁落地在**獨立的短
交易**裡，記憶體只跟單頁大小成正比；等所有頁都進了 staging，才在**單一交易**內把內容合併回
目標表——退回成資料庫早已高度優化的單一交易操作，原子性由資料庫保證，應用層不必自己湊合。

## 2. 核心設計決策

1. **staging＋單一交易原子切換（mark-and-sweep），取代全量載入或天真分批 commit**：逐頁抓取、
   攤平、寫進 staging（各自獨立短交易）；全部頁寫完後才在單一交易內合併——先整批標記 3 張目標
   表 `is_active=false`，再依 staging 內容逐筆 upsert 復活並更新欄位。
2. **`sync_runs` 狀態機作為協調中樞**：`fetching → staged → swapping → done`，加上
   `fetch_failed`（Phase 1 失敗）與 `abandoned`（人工放棄，僅限 `staged`）。每個 phase 都有對應
   的可觀測進度欄位，也是判斷殘留執行如何復原的唯一依據（見 §4）。
3. **PostgreSQL session advisory lock，綁定一條專用連線**：從連線池借出**專用 client** 執行
   `pg_try_advisory_lock`，全程沿用同一條連線直到明確 `release()`。鎖是連線（session）的
   屬性，非資料庫的全域狀態；透過連線池隨機配對的兩次呼叫取得／釋放，可能落在不同實體連線上，
   導致釋放失敗或釋放了別人持有的鎖。
4. **鎖不夠，還要 fencing（`owner_token`／`lease_version`）**：連線斷線鎖會自動釋放，但持有
   該連線的 worker 進程未必真的停止，仍可能繼續寫入（stale writer）。`SyncRunFence`（`runId`／
   `phase`／`ownerToken`／`leaseVersion`）讓每次狀態轉移都須「連同上一輪憑證」送出，資料庫端以
   `WHERE id AND phase AND owner_token AND lease_version` 做 CAS，對不上就拋
   `FenceLostError`。**鎖＝誰先開始，fencing＝誰現在還算數**。
5. **partial unique index，作為繞過鎖之後的最後防線**：`uq_sync_runs_active` 建在 `sync_type`
   上、`WHERE phase IN ('fetching','staged','swapping')`。即使應用層的鎖與狀態機邏輯被程式
   疏漏繞過，insert 撞 `23505` 仍會被資料庫擋下轉譯成 `ActiveSyncRunError`——不建立在「所有
   呼叫路徑都記得先取鎖」的假設上。
6. **合併一律用來源業務鍵當 conflict target，不用本地自增主鍵**：`template_items.sourceListId`
   存業務鍵，不是本地 `id`。全量刷新每次都可能整批換一輪本地 PK 世代；用本地 PK 做關聯的邏輯，
   下一輪同步後全部失效，會看到大量對不上的孤兒。
7. **切換失敗不必重抓，直接重播已有的 staged 資料**：切換交易失敗則 rollback、狀態退回
   `staged`（保留原 fence），staging 資料原封不動。下次觸發時 `recoverActiveRun` 直接跳過
   Phase 1、重播 Phase 2——Phase 1（大量網路 I/O）成本遠高於 Phase 2。
8. **衍生欄位（`position`）在切換交易內以 set-based SQL 重算**：`position` 由 `priority` 推導，
   須在合併完成、`is_active` 底定後才重算。用 `ROW_NUMBER() OVER (PARTITION BY source_list_id
   ORDER BY priority DESC, source_item_id ASC)` 一次算完啟用中項目的名次，只處理
   `is_active=true` 的列；次要排序鍵保證同 `priority` 時仍有決定性結果。
9. **MVCC 保證讀取者不會看到「mark 完、merge 一半」的中間態，代價是切換期間寫入者要等鎖**：
   mark-and-sweep 在單一交易內完成，其他連線 commit 前只看舊資料、commit 後立刻看新資料，沒有
   第三種可見狀態。代價是切換交易持有目標表大量列鎖，這段期間其他**寫入者**（非讀取者）會被
   鎖等待，直到 commit 或 rollback。

## 3. 資料表

### 3.1 `sync_runs`（狀態機協調表，`packages/db/src/schema/staging-sync.ts`）
| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `id` | serial PK | |
| `sync_type` | varchar(50) | 同步類型識別碼；本範例僅 `template_catalog` 一種 |
| `phase` | enum | `fetching`／`staged`／`swapping`／`done`／`fetch_failed`／`abandoned` |
| `owner_token`／`lease_version` | uuid,null／integer 預設0 | fencing 憑證：本輪合法執行者識別碼＋每次 CAS 遞增版本號；到終態即清 `owner_token` |
| `lock_backend_pid`／`heartbeat_at` | integer,null／timestamptz,null | 持鎖連線 `pg_backend_pid`（觀測用）；Phase 1 逐頁寫入時更新 |
| `last_offset`／`page_count`／`source_count` | integer, null | Phase 1 抓取進度與來源總筆數 |
| `staged_counts` | jsonb, null | `{ lists, items, tags }` 各表暫存筆數 |
| `peak_memory_bytes` | bigint, null | Phase 1 期間追蹤到的 heap 使用峰值 |
| `fetch_seconds`／`swap_seconds`／`swap_attempts` | numeric,null／integer預設0 | 兩階段耗時；`swap_attempts` 為進入 `swapping` 次數（含失敗後重播） |
| `result_code` | varchar(30), null | `success`／`no_data`／`fetch_failed`／`swap_failed`／`abandoned` |
| `last_error_phase`／`error_message` | varchar,null／text,null | 失敗發生階段；消毒過訊息 `錯誤類別: 訊息前 300 字`，禁止存完整 body／payload／token |
| `abandoned_by`／`abandoned_reason`／`abandoned_at` | varchar／text／timestamptz, null | 人工放棄的操作者、原因、時間 |
| `started_at`／`staged_at`／`finished_at` | timestamptz | 各階段時間戳 |
| `created_at`／`updated_at` | timestamptz | |

索引：`uq_sync_runs_active`——見 §2 決策 5。

### 3.2 目標表（`packages/db/src/schema/template-catalog.ts`）

- **`template_lists`**：`id` serial PK、`source_list_id`（UNIQUE，merge conflict target）、
  `title`、`description`（null）、`is_active`（預設 true）、`created_at`／`updated_at`。
- **`template_items`**：`id` serial PK、`source_item_id`（UNIQUE）、`source_list_id`（**刻意
  存業務鍵**關聯 `template_lists.source_list_id`，非本地 FK——見決策 6）、`title`、`priority`、
  `position`（衍生欄位，merge 交易內以 window function 重算，見決策 8）、`is_active`、
  timestamps。
- **`template_item_tags`**：`id` serial PK、`source_item_id`、`tag`、`is_active`、
  `UNIQUE (source_item_id, tag)`（複合 conflict key 示範）、timestamps。

### 3.3 staging 暫存表（`template_lists_staging`／`template_items_staging`／`template_item_tags_staging`）

共同規則：都有 `id` PK、`sync_run_id`（index，做「run 隔離」）、`source_page`／`source_row`
（除錯欄位，刻意**不進** conflict key）；conflict key 一律 `(sync_run_id, 業務鍵)` UNIQUE
（`template_item_tags_staging` 為 `(sync_run_id, source_item_id, tag)` 複合鍵），同時做到
「不同 run 互不干擾」與「同一 run 內跨頁重複業務鍵 last-row-wins」；皆**不含**
`is_active`／`position`（只在目標表計算），也**不存**目標表本地 `id`；payload 欄位對齊目標表
（`manifest.ts` 的 `payloadColumns` 為單一事實來源）：lists 為 `title`／`description`，items
為 `source_list_id`／`title`／`priority`，tags 除 conflict key 外無額外 payload。

## 4. 狀態機

```
啟動 ──insert──► fetching ──全部頁寫完 staging──► staged
                    │                                │
                    │來源回傳 0 筆                     │Phase 2：單一交易 mark-and-sweep
                    ▼                                ▼
              done(result=no_data)              swapping ──commit 成功──► done(result=success)
                    ▲                                │
                    │                                │交易失敗(rollback)
                    │                                ▼
                    │                     staged(保留 fence, result=swap_failed)
                    │                                │
                    │                      人工 abandon(僅限 staged)
                    │                                ▼
                    └──────────────────────────── abandoned

任一頁重試耗盡 ──► fetch_failed(僅發生於 fetching 階段)

crash recovery(取得 syncType 全域鎖後，recoverActiveRun 判定殘留執行):
  殘留 fetching ──判死──► fetch_failed              (Phase 1 半途而廢，staging 不可信)
  殘留 swapping ──退回──► staged，lease_version+1    (swap 交易未 commit，資料庫視為未發生)
  殘留 staged   ──原樣回傳──► 直接重播 Phase 2，不重新 fetch
```

crash recovery 只需判斷「殘留在 `fetching`／`staged`／`swapping` 的列」，前提是呼叫端已持有
`sync_type` 的全域 advisory lock——殘留列不可能是同一輪還活著的執行（活著就會持有鎖），一定是前
一個 worker 異常終止的孤兒。

## 5. Phase 1／Phase 2 流程

### Phase 1（抓取＋暫存，逐頁短交易）

`page-fetcher.ts`／`page-transformer.ts`／`staging-writer.ts` 已實作；`orchestrator.ts` 尚未
實作，以下依設計契約描述：

1. dispatcher 已透過 `mutex.ts` 的 `acquireSyncLock(syncType)` 取得 advisory lock。
2. `recoverActiveRun(syncType)`（已實作）檢查有無殘留 active run（見 §4）：殘留 `staged` 直接
   回傳 fence（跳過 Phase 1）；殘留 `fetching` 判死轉 `fetch_failed`；殘留 `swapping` 退回
   `staged`；都沒有則呼叫 `startFetching` 開新一輪。
3. `streamCatalogPages(config)` 以 async generator 逐頁惰性抓取：`GET
   /mock-source/template-catalog?limit=&offset=`，`count < pageSize` 判定尾頁；單頁重試只
   重試網路錯誤／5xx，最多 `fetchRetries` 次，4xx 或重試耗盡拋 `SourceFetchError`。
4. 每一頁：`transformPage(pageIndex, rows)` 把巢狀 rows 攤平成三組 keyed buffer（`lists`／
   `items`／`tags`），頁內重複業務鍵 last-row-wins。
5. `staging-writer.ts` 的 `writePage(fence, checkpoint, buffers)`（已實作）：每頁一個短交易——
   `SELECT ... FOR UPDATE` 鎖 run row → 驗 fence（`phase='fetching'`）→ 依 `manifest.ts` 逐表
   以 `STAGING_CHUNK_SIZE`（500）chunk `INSERT ... ON CONFLICT (sync_run_id, 業務鍵) DO
   UPDATE` → 同交易更新檢查點（呼叫端傳絕對值，不做累加）。orchestrator（尚未實作）每處理完
   一頁即應釋放參照、追蹤 heapUsed 峰值——這正是「記憶體只跟單頁大小成正比」的落地位置。
6. 全部頁抓完：`sourceCount === 0` → `markNoData`（已實作）直接進終態
   `done(result_code=no_data)`，不進 Phase 2；否則 `markStaged`（已實作）轉 `staged`。
7. 任何階段拋錯 → `failPhaseOne`（已實作）轉 `fetch_failed`，重新拋出給 dispatcher。

### Phase 2（原子切換，單一交易）——`merger.ts`（已實作）的 `swap(stagedFence, options)`

1. `claimForSwap(stagedFence)`（已實作）：交易內 `FOR UPDATE` 鎖 run row，驗 fence
   （`phase='staged'`），CAS 轉 `swapping`（換發新 `owner_token`、`lease_version+1`、
   `swap_attempts+1`）。
2. 開啟切換交易，再次 `FOR UPDATE` 驗 fence（`phase='swapping'`）。
3. **mark**：3 張目標表整批 `UPDATE SET is_active=false`。
4. **merge**：依 `manifest.ts` 逐表 `INSERT ... SELECT FROM staging WHERE sync_run_id=$ ON
   CONFLICT (業務鍵) DO UPDATE SET payload欄位..., is_active=true, updated_at=now()`。
5. `recomputePositions(tx)`：對 `is_active=true` 的 `template_items` 以 `ROW_NUMBER() OVER
   (PARTITION BY source_list_id ORDER BY priority DESC, source_item_id ASC)` 重算 `position`。
6. `completeInsideTransaction(tx, fence, summary)`（已實作，**須傳入 tx**）：同一交易內
   `phase → done`、`result_code=success`。
7. commit 成功後：best-effort 刪除該 run 的 staging 列（失敗只 warn，殘留交給 pruner）。
8. 交易失敗（含測試用 `failureInjector` 於 `after_mark:<table>`／`after_merge:<table>`／
   `after_positions` hook 注入的模擬崩潰）：rollback → `returnSwapToStaged`（已實作）退回
   `staged`（保留原 fence）→ 重拋給 dispatcher。

`dispatcher.ts`（設計中）的 `runTemplateCatalogSync()` 串起兩階段：`acquireSyncLock` →
`orchestrator.runPhaseOne` →（結果為 `staged` 才）`merger.swap` → 組結果摘要
`{ runId, resultCode, phase, pageCount, sourceCount, stagedCounts, fetchSeconds,
swapSeconds }` → `finally` 釋放鎖。

## 6. 模組配置

`apps/server/src/staging-sync/`：
| 檔案 | 職責 | 狀態 |
| --- | --- | --- |
| `constants.ts` | phase／result code 常數、`SYNC_TYPE_TEMPLATE_CATALOG`、`STAGING_CHUNK_SIZE=500` | 已實作 |
| `errors.ts` | `ActiveSyncRunError`／`LockConflictError`／`LockError`／`FenceLostError`／`SourceFetchError` | 已實作 |
| `config.ts` | `getStagingSyncConfig()`／`setStagingSyncConfigForTest()`：來源 URL（`STAGING_SYNC_SOURCE_URL`）、頁面大小（`STAGING_SYNC_PAGE_SIZE`）、逾時（`STAGING_SYNC_FETCH_TIMEOUT_MS`）、重試與 retention 設定 | 已實作 |
| `fence.ts` | `SyncRunFence` 型別：fencing 憑證，隨狀態轉移一起傳遞 | 已實作 |
| `types.ts` | 管線各階段共用資料形狀（`SourcePage`／`PageBuffers`……），三模組間的介面契約 | 已實作 |
| `manifest.ts` | 3 表 manifest：目標表、staging 表、conflict key、payload 欄，writer／merger／測試共用 | 已實作 |
| `mutex.ts` | `acquireSyncLock(syncType)`：借專用 client 執行 `pg_try_advisory_lock` | 已實作 |
| `run-manager.ts` | `sync_runs` 狀態機 repository：`startFetching`／`markStaged`／`markNoData`／`failPhaseOne`／`claimForSwap`／`completeInsideTransaction`／`returnSwapToStaged`／`recoverActiveRun`／`abandon` | 已實作 |
| `page-fetcher.ts` | `streamCatalogPages(config)` async generator：逐頁惰性抓取，含重試與終止條件 | 已實作 |
| `page-transformer.ts` | `transformPage(pageIndex, rows)`：巢狀資料攤平成三組 keyed buffer | 已實作 |
| `staging-writer.ts` | `writePage(fence, checkpoint, buffers)`：每頁一個短交易，驗 fence＋chunk upsert | 已實作 |
| `merger.ts` | `swap(stagedFence, options)`：Phase 2 單一交易，mark-and-sweep＋position 重算 | 已實作 |
| `orchestrator.ts` | `runPhaseOne(lease)`：串起 recover／startFetching／逐頁寫入／markStaged／markNoData／failPhaseOne | 設計中（§5） |
| `dispatcher.ts` | `runTemplateCatalogSync()`：取鎖 → Phase 1 →（`staged`才）Phase 2 → 摘要 → 釋放鎖 | 設計中（§5） |
| `pruner.ts` | `pruneStagingSyncRuns()`：依 retention（done 1 日／failed·abandoned 7 日／終態 run 90 日）清理，不碰進行中 phase | 已實作 |

其他相關檔案：
- `routes/mock-source.ts`（**已實作**）：mock 範本庫 API（`GET
  /mock-source/template-catalog?limit=&offset=&overlap=&total=`；`PUT /mock-source/mode` 切
  `success`／`fail`／`fail_page_2`／`flaky_page_2`／`empty`；`POST /mock-source/reset` 復位），
  資料集決定性生成、無認證。
- `routes/staging-sync-admin.ts`（設計中，全掛 `app.authenticate`）：`POST /staging-sync/trigger`
  （200完成含`no_data`／409鎖或active run衝突／503鎖層錯誤，body為消毒過摘要不含 token）；`GET
  /staging-sync/runs?limit=20`（不含 `owner_token`）；`POST /staging-sync/runs/:id/abandon`
  （body `{reason}`，僅限 `staged`，非 `staged` 回 422）；`GET /staging-sync/catalog`（生效中
  lists＋items 依 `position` 排序＋tags）。
- `scripts/staging-sync-*.ts`（設計中，比照 outbox scripts）：`staging-sync-run.ts`（結束碼 `0`
  成功／`2`＝`no_data`**視為非正常完成**／`1`失敗或鎖衝突）；`staging-sync-status.ts`
  （`--limit`）；`staging-sync-abandon.ts <runId> --reason=...`；`staging-sync-prune.ts`。
- `apps/web` 的 `/staging-sync-guide`（設計中，受保護路由）：架構圖／狀態機圖／fencing 概念圖
  （內嵌 SVG）＋ Phase 1／2 時序；串 `GET /staging-sync/runs`／`/staging-sync/catalog`，提供
  「觸發同步／切換 mock 模式／放棄 staged 執行」按鈕。

## 7. 教學重點問答

**Q1：為什麼「天真分批 commit」會出現「資料看起來被刪掉」的假象？**
mark-and-sweep 的「mark」已先執行，但「sweep」被切成多筆獨立交易，任何一筆中途失敗，目標表就
停在「已 mark、還沒完全 sweep 回來」的狀態——使用者看到一部分資料消失，且無法簡單回到刷新前
的一致狀態。
**Q2：為什麼 staging＋單一交易切換能同時封頂記憶體又保住原子性？**
兩件事拆到不同階段：Phase 1 逐頁寫進 staging，記憶體只跟單頁大小成正比，可無限逐頁；Phase 2
只在全部資料已安全落地 staging 後才發生，是資料庫原生支援的單一交易操作，原子性由資料庫保證。
**Q3：為什麼 advisory lock 不夠，還要 fencing？**
Advisory lock 綁在單一連線（session）上，連線斷線鎖會自動釋放，但持有該連線的 worker 進程未必
真的停止，可能還在背景繼續寫入。單靠鎖無法分辨「這個寫入是否來自已失去鎖的舊 worker」；fencing
token 讓每次寫入都必須證明自己仍是「當下合法」的執行者。**鎖解決「誰先開始」，fencing 解決
「誰現在還算數」**——兩個不同層次的保護，缺一不可。
**Q4：partial unique index 如何做為「最後防線」的持久 invariant？**
`uq_sync_runs_active` 建在資料庫層，不依賴任何應用層程式碼路徑是否正確檢查過。就算 advisory
lock 與狀態機邏輯都因程式疏漏被繞過，insert 第二個進行中的 `sync_type` 執行仍會直接撞 `23505`
被拒絕——可靠性不建立在「所有呼叫路徑都記得先取鎖」的假設上。
**Q5：為什麼合併要用「來源業務鍵」而非本地主鍵？**
全量刷新的本質是「每次同步都可能整批換一輪本地自增主鍵世代」。若關聯或合併邏輯用本地 PK 做
依據，下一輪同步後全部失效——用本地 PK join 的查詢會看到大量「孤兒」。只有來源系統穩定不變的
業務鍵，才能保證跨多輪同步的一致性。
**Q6：swap 失敗後為什麼能「不重新抓」直接重播？**
staged 資料集在切換失敗當下仍完整保留在 staging 表裡——切換交易失敗只 rollback 了「合併到目標
表」這個動作，不影響已逐頁寫入且獨立提交的 staging 資料。下次觸發時 `recoverActiveRun` 找到
殘留的 `staged` 執行，直接把同一份 fence 交回去重播 Phase 2，完全不需要重新對來源服務發出請求。
