# Staging Sync 教學範例 — 設計文件

> 本文件是本專案「暫存表＋原子切換（staging + atomic swap）模式」教學範例的設計依據。模式源自
> 一類真實系統反覆出現的問題：定期把一份**大量、巢狀**的外部資料**全量刷新**進本地資料庫，去
> 識別化後以「mock 範本庫（template catalog provider）」情境重現：mock 服務以分頁回傳「範本
> 清單 → 項目 → 標籤」，本地定期整批同步，過程中衍生欄位（排序位置）要重新計算。全部模組
> （schema、mock 來源 API、advisory lock、狀態機、逐頁抓取／轉換、staging 寫入、原子切換、
> retention 清理、orchestrator／dispatcher、維運端點、CLI、前端教學頁）皆已實作並通過測試
> （`pnpm --filter server test` 282/282、`pnpm --filter web test` 29/29）。

## 1. 要解決的問題（分批的是記憶體，不是 commit）

「一次抓完所有分頁、全部載入記憶體再處理」和「每抓完一頁就對目標表 commit 一次」，是全量同步
最常見的兩種天真做法，各自踩到不同的坑：

- **全部載入記憶體**：process 記憶體用量與來源總筆數成正比，資料量夠大就一定 OOM，且無法優雅
  降級——沒有「處理到一半」，只有「成功」或「整個 process 被殺掉」。
- **天真分批 commit**：每抓完一頁就 commit，記憶體用量封頂在單頁大小沒錯，但把天生需要原子性
  的「全量刷新」切成多筆獨立交易。若刷新邏輯先標記舊資料過期、再逐頁 upsert 新資料，任何一頁
  中途失敗，目標表就停在「已 mark、還沒完全 sweep 回來」的狀態——使用者看到「資料被刪掉一半」
  的假象，且無法簡單退回刷新前的樣子。

**核心原則，貫穿本範例全部設計：分批的是記憶體，不是 commit。** Staging 暫存表把「封頂記憶體」
與「保住原子性」解耦：抓取階段可無限逐頁、每頁落地在**獨立的短交易**裡，記憶體只跟單頁大小成
正比；等所有頁都進了 staging，才在**單一交易**內把內容合併回目標表——退回成資料庫早已高度
優化的單一交易操作，原子性由資料庫保證，應用層不必自己湊合。

## 2. 核心設計決策

1. **staging＋單一交易原子切換（mark-and-sweep）**：逐頁抓取、攤平、寫進 staging（各自獨立短
   交易）；全部頁寫完後才在單一交易內合併——先整批標記 3 張目標表 `is_active=false`，再依
   staging 內容逐筆 upsert 復活並更新欄位。
2. **`sync_runs` 狀態機作為協調中樞**：`fetching → staged → swapping → done`，加上
   `fetch_failed`（Phase 1 失敗）與 `abandoned`（人工放棄，僅限 `staged`）；每個 phase 都有可
   觀測進度欄位，也是判斷殘留執行如何復原的唯一依據（見 §4）。
3. **PostgreSQL session advisory lock，綁定一條專用連線**：從連線池借出**專用 client** 執行
   `pg_try_advisory_lock`，全程沿用同一條連線直到明確 `release()`——鎖是連線（session）屬性，
   非資料庫全域狀態，用 `db` 隨機借連線取得／釋放可能落在不同實體連線上而失敗或誤釋放他人的鎖。
4. **鎖不夠，還要 fencing（`owner_token`／`lease_version`）**：連線斷線鎖自動釋放，但持有該
   連線的 worker 進程未必真的停止，仍可能繼續寫入（stale writer）。`SyncRunFence` 讓每次狀態
   轉移都須連同上一輪憑證送出，資料庫端以 `WHERE id AND phase AND owner_token AND
   lease_version` 做 CAS，對不上就拋 `FenceLostError`。**鎖＝誰先開始，fencing＝誰現在還算數**。
5. **partial unique index，繞過鎖之後的最後防線**：`uq_sync_runs_active` 建在 `sync_type` 上、
   `WHERE phase IN ('fetching','staged','swapping')`；即使鎖與狀態機邏輯被程式疏漏繞過，
   insert 撞 `23505` 仍會被資料庫擋下轉譯成 `ActiveSyncRunError`。
6. **合併一律用來源業務鍵當 conflict target，不用本地自增主鍵**：`template_items.sourceListId`
   存業務鍵，非本地 `id`——全量刷新每次都可能整批換一輪本地 PK 世代，用本地 PK 關聯下一輪同步
   後全部失效，會看到大量對不上的孤兒。
7. **切換失敗不必重抓，直接重播已有的 staged 資料**：切換交易失敗則 rollback、狀態退回
   `staged`（保留原 fence），staging 資料原封不動；下次觸發時 `recoverActiveRun` 直接跳過
   Phase 1、重播 Phase 2——Phase 1（大量網路 I/O）成本遠高於 Phase 2。
8. **衍生欄位（`position`）在切換交易內以 set-based SQL 重算**：須在合併完成、`is_active` 底定
   後才重算，`ROW_NUMBER() OVER (PARTITION BY source_list_id ORDER BY priority DESC,
   source_item_id ASC)` 一次算完啟用中項目的名次，同 `priority` 時以次要鍵決勝，結果決定性。
9. **MVCC 保證讀取者不會看到「mark 完、merge 一半」的中間態**：mark-and-sweep 在單一交易內
   完成，其他連線 commit 前只看舊資料、commit 後立刻看新資料，代價是其他**寫入者**（非讀取者）
   在切換交易持有目標表列鎖期間會被鎖等待。

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
（`template_item_tags_staging` 為三欄複合鍵），同時做到「不同 run 互不干擾」與「同一 run 內跨頁
重複業務鍵 last-row-wins」；皆**不含** `is_active`／`position`，也**不存**目標表本地 `id`；
payload 欄位對齊目標表（`manifest.ts` 的 `payloadColumns` 為單一事實來源）。

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

### Phase 1（抓取＋暫存，逐頁短交易）——`orchestrator.ts` 的 `runPhaseOne(lock, options?)`

1. dispatcher 已透過 `mutex.ts` 的 `acquireSyncLock(syncType)` 取得 advisory lock。
2. `recoverActiveRun(syncType)` 檢查有無殘留 active run（見 §4）：殘留 `staged`／`swapping`
   （已退回 `staged`）直接回傳 fence（`replayed=true`，跳過 Phase 1）；殘留 `fetching` 判死轉
   `fetch_failed`；都沒有則呼叫 `startFetching` 開新一輪。
3. `streamCatalogPages(config)` 以 async generator 逐頁惰性抓取（`count < pageSize` 判尾頁，
   單頁重試只重試網路錯誤／5xx，最多 `fetchRetries` 次，4xx 或耗盡拋 `SourceFetchError`；惰性由
   `page-fetcher.test.ts` 鎖住：for-await 拿到第一頁就 `break`，只發一次 HTTP 請求）。
4. 每一頁：`transformPage` 攤平成三組 keyed buffer（頁內重複業務鍵 last-row-wins）；
   `writePage(fence, checkpoint, buffers)` 每頁一個短交易——`FOR UPDATE` 鎖 run row → 驗 fence
   （`phase='fetching'`）→ 依 `manifest.ts` 逐表 chunk upsert → 同交易更新檢查點（絕對值，不
   累加）。處理完一頁即釋放參照、追蹤 `heapUsed` 峰值——這正是「記憶體只跟單頁大小成正比」的
   落地位置。
5. 全部頁抓完：`sourceCount === 0` → `markNoData` 直接進終態 `no_data`；否則 `markStaged` 轉
   `staged`。
6. **錯誤遮蔽保護**（審查修復）：任何階段拋錯 → `failPhaseOne(fence, currentSubPhase, error)`
   轉 `fetch_failed`。這一步本身也可能失敗——fence 可能已被另一個持鎖 worker 的
   `recoverActiveRun` 判死收尾，導致 `failPhaseOne` 因 0 列命中再拋 `FenceLostError`；此時只記
   一筆結構化 `console.warn`，**絕不能讓它蓋掉原始錯誤**，呼叫端最終必須看到造成失敗的真正
   原因（已在 `orchestrator.test.ts` 用真實 DB 重現過遮蔽）。

### Phase 2（原子切換，單一交易）——`merger.ts` 的 `swap(stagedFence, options?)`

1. `claimForSwap`：交易內 `FOR UPDATE` 鎖 run row，驗 fence（`phase='staged'`），CAS 轉
   `swapping`（換發新 `owner_token`、`lease_version+1`、`swap_attempts+1`）。
2. 開啟切換交易，再次 `FOR UPDATE` 驗 fence（`phase='swapping'`）。
3. **mark**：3 張目標表整批 `UPDATE SET is_active=false`。
4. **merge**：依 `manifest.ts` 逐表 `INSERT ... SELECT FROM staging ... ON CONFLICT (業務鍵)
   DO UPDATE SET payload 欄位..., is_active=true`。
5. `recomputePositions(tx)`：對啟用中 `template_items` 以 `ROW_NUMBER() OVER (PARTITION BY
   source_list_id ORDER BY priority DESC, source_item_id ASC)` 重算 `position`。
6. `completeInsideTransaction(tx, fence, summary)`（**須傳入 tx**）：同一交易內 `phase→done`。
7. commit 成功後：best-effort 刪除該 run 的 staging 列（失敗只 warn，殘留交給 pruner）。
8. 交易失敗（含測試用 `failureInjector` 模擬崩潰）：rollback → `returnSwapToStaged` 退回
   `staged`（保留原 fence）→ 重拋。**同樣有錯誤遮蔽保護**：`returnSwapToStaged` 因 fence 已被
   搶走再拋 `FenceLostError` 時，一律只記結構化 warning，讓原始 error 浮上去（與 Phase 1 對稱）。

`dispatcher.ts` 的 `runTemplateCatalogSync()` 串起兩階段：`acquireSyncLock` →
`orchestrator.runPhaseOne` →（結果為 `staged` 才）`merger.swap` → 組摘要 → `finally` 釋放鎖。
鎖層錯誤與 Phase 1／2 過程中的錯誤一律原樣重拋，不吞、不轉譯——HTTP 狀態碼映射是呼叫端
（admin 路由）的責任。

## 6. 模組配置

`apps/server/src/staging-sync/`（全部已實作）：
| 檔案 | 職責 |
| --- | --- |
| `constants.ts` | phase／result code 常數、`SYNC_TYPE_TEMPLATE_CATALOG`、`STAGING_CHUNK_SIZE=500` |
| `errors.ts` | `ActiveSyncRunError`／`LockConflictError`／`LockError`／`FenceLostError`／`SourceFetchError` |
| `config.ts` | `getStagingSyncConfig()`／`setStagingSyncConfigForTest()`：來源 URL、頁面大小、逾時、重試與 retention 設定 |
| `fence.ts` | `SyncRunFence` 型別：fencing 憑證，隨狀態轉移一起傳遞 |
| `types.ts` | 管線各階段共用資料形狀（`SourcePage`／`PageBuffers`……），三模組間的介面契約 |
| `manifest.ts` | 3 表 manifest：目標表、staging 表、conflict key、payload 欄，writer／merger／pruner／測試共用的單一事實來源 |
| `mutex.ts` | `acquireSyncLock(syncType)`：借專用 client 執行 `pg_try_advisory_lock`；`pool.connect()` 失敗也轉譯為 `LockError`，維持「取鎖層錯誤一律 503」的契約 |
| `run-manager.ts` | `sync_runs` 狀態機 repository：`startFetching`／`markStaged`／`markNoData`／`failPhaseOne`／`claimForSwap`／`completeInsideTransaction`／`returnSwapToStaged`／`recoverActiveRun`／`abandon` |
| `page-fetcher.ts` | `streamCatalogPages(config)` async generator：逐頁惰性抓取，含重試與終止條件 |
| `page-transformer.ts` | `transformPage(pageIndex, rows)`：巢狀資料攤平成三組 keyed buffer |
| `staging-writer.ts` | `writePage(fence, checkpoint, buffers)`：每頁一個短交易，驗 fence＋chunk upsert |
| `merger.ts` | `swap(stagedFence, options)`：Phase 2 單一交易，mark-and-sweep＋position 重算＋錯誤遮蔽保護 |
| `orchestrator.ts` | `runPhaseOne(lock, options)`：串起 recover／startFetching／逐頁寫入／markStaged／markNoData／failPhaseOne＋錯誤遮蔽保護 |
| `dispatcher.ts` | `runTemplateCatalogSync(options)`：取鎖 → Phase 1 →（`staged`才）Phase 2 → 摘要 → 釋放鎖 |
| `pruner.ts` | `pruneStagingSyncRuns()`：依 retention（done 1 日／failed·abandoned 7 日／終態 run 90 日）清理，不碰進行中 phase |

其他相關檔案：`routes/mock-source.ts`（mock 來源 API）、`routes/staging-sync-admin.ts`（4 支
維運端點，見 §7）、`scripts/staging-sync-*.ts`（4 支維運 CLI，見 §8）、
`apps/web/src/routes/staging-sync-guide.tsx`（前端教學頁，見 §11）。

## 7. HTTP 端點

Mock 範本庫來源（**無**認證，模擬第三方；狀態存 module 層記憶體）：`GET
/mock-source/template-catalog?limit=&offset=&overlap=&total=`（決定性生成，同組參數永遠回傳
相同內容；`overlap=1` 時 `offset>0` 的頁會多塞一列上一頁末筆，模擬分頁微漂移）、`PUT
/mock-source/mode` body `{ mode }`（切換 `success`／`fail`／`fail_page_2`／`flaky_page_2`／
`empty` 五種故障模式）、`POST /mock-source/reset`（清空狀態並恢復預設模式）。

Staging Sync 管理（`routes/staging-sync-admin.ts`，全掛 `app.authenticate`）：

- `POST /staging-sync/trigger`：呼叫 `runTemplateCatalogSync()`。`200` 成功（含
  `no_data`），body 為消毒過的結果摘要（不含 `owner_token`）；`409`＝`ActiveSyncRunError`
  （已有進行中執行）或 `LockConflictError`（鎖忙碌），對呼叫端都是「沒搶到，等下次」；`503`＝
  `LockError`（取鎖過程本身出錯，如連線池故障，語意上是鎖層失效而非單純忙碌）；`502`＝其餘
  錯誤（`SourceFetchError`、swap 失敗……），body 為消毒過的錯誤訊息。
- `GET /staging-sync/runs?limit=20`（上限 100）：查最近 N 筆執行摘要，逐欄位列舉輸出，刻意不
  整列 spread——回應**必不含** `owner_token`。
- `POST /staging-sync/runs/:id/abandon` body `{ reason }`：呼叫 `run-manager.abandon`，操作者
  取登入者 email。`200` 放棄成功；`422`＝目標不存在或非 `staged`（`abandon` 回傳 `null` 的轉譯
  ，刻意設計成回傳值而非拋錯，因為這是操作者可預期的正常分支，非系統例外）；`400`＝`id` 非正
  整數或 `reason` 缺漏／空白。
- `GET /staging-sync/catalog`：回傳生效中（`is_active=true`）的 lists＋items（依 `position`
  排序）＋tags 巢狀組合。**三個 SELECT 包在同一個 `REPEATABLE READ` 唯讀交易內**一起執行（審查
  修復）——光包一層 `db.transaction(...)` 不指定隔離級（預設 `READ COMMITTED`）不夠，該隔離級
  下同一交易的每個語句仍各自重新取得快照，`merger.swap()` 的原子切換一旦恰好在三個查詢之間
  commit，回應就撕裂成新舊世代拼接的結果；唯有 `REPEATABLE READ`（或更高）能讓整個交易固定在
  單一快照，保證三者一致（已用真實 Postgres 重現過撕裂）。

## 8. CLI

4 支維運腳本位於 `apps/server/src/scripts/`（比照既有 `outbox-*.ts` 慣例），皆抽出可直接單元
測試的核心函式，`main()` 只在直接執行（非被測試 import）時才跑。`apps/server/package.json`
scripts：`staging-sync:run`／`staging-sync:status`／`staging-sync:abandon`／
`staging-sync:prune`（皆 `tsx src/scripts/staging-sync-*.ts`）。

| 腳本 | 用法 | exit code |
| --- | --- | --- |
| `staging-sync-run.ts` | 呼叫 `runTemplateCatalogSync()` | `0`＝success；`2`＝`no_data`（來源 0 筆，流程正常結束但**視為非正常完成**，避免排程誤判「同步完成」而放行下游）；`1`＝其餘失敗或鎖衝突 |
| `staging-sync-status.ts --limit=N` | 列最近 N 筆（預設 20，上限 100），輸出消毒欄位（不含 `owner_token`） | `0`；僅參數或查詢出錯才 `1` |
| `staging-sync-abandon.ts <runId> --reason="..."` | `<runId>`／`--reason` 皆必填（避免誤觸放棄），operator 為 `cli:<OS 使用者名稱>` | 成功 `0`；非 `staged` 或不存在 `1` |
| `staging-sync-prune.ts` | 呼叫 `pruneStagingSyncRuns()`，不接受參數覆寫保留期門檻（治理層設定，不讓單次執行臨時改動） | 恆 `0` |

## 9. 環境變數

`packages/env/src/server.ts`（皆 `z.coerce.number().int().positive()` 附預設值，或 `z.url()`）：

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `STAGING_SYNC_SOURCE_URL` | `http://localhost:7529/mock-source/template-catalog` | mock 範本庫來源端點 |
| `STAGING_SYNC_PAGE_SIZE` | `50` | 每頁筆數；封頂記憶體的關鍵參數，見 `page-fetcher.ts` |
| `STAGING_SYNC_FETCH_TIMEOUT_MS` | `10000` | 單次抓取單頁的 HTTP 逾時（毫秒） |

只需寫進根目錄 `.env.example`（Docker Compose 讀取代換），與 `OUTBOX_*` 系列同一慣例，
`apps/server/.env.example` 只放本機直連 DB 所需的最小變數集，不重複列出這些跑容器內才用得到
的設定。`fetchRetries`／`fetchRetryDelayMs`／retention 天數等非 env 層級設定，由 `config.ts`
以程式內建預設值提供（見 §6）。

## 10. 測試策略

分層測試，全部打真實 Postgres（沿用專案既有整合測試基礎設施，非 mock DB）：

- **核心模組層**（`staging-sync/*.test.ts`，§6 每支模組各一支測試檔）：直接呼叫模組函式，不
  透過 HTTP；`page-fetcher` 以 `app.listen({ port: 0 })` 起真實 HTTP 佐證逐頁抓取（含惰性、
  重試、故障模式）；`merger`／`dispatcher` 用 `failureInjector` 注入模擬切換中途崩潰。
- **路由層**：fastify inject 驗證 HTTP 狀態碼契約（401／200／409／503／422／400）與回應形狀
  （`runs`／`catalog` 不含 `owner_token`）。
- **CLI 層**：直接呼叫腳本抽出的核心函式（`runStagingSyncOnce`／`parseStatusArgs`……），驗證
  exit code 與參數邊界，不 spawn 子行程。
- **前端層**：`use-staging-sync-guide.test.tsx` mock `lib/staging-sync-api.ts`，驗證 hook 的
  載入／錯誤／觸發／放棄行為。

資料庫隔離：測試一律連到獨立測試庫（`<db>_test`），`resetDb()` 涵蓋 `sync_runs`／3 張 staging
表／3 張目標表的 TRUNCATE（見根目錄 `CLAUDE.md`「測試資料庫隔離」段落）。`TEST_DATABASE_URL`
可覆寫推導出的測試庫名稱——若要平行跑多組測試（例如各 CI job 分別指向不同測試庫，避免互搶
列鎖或 TRUNCATE 互相干擾），分別設定不同值即可，`_test` 結尾防呆對任何命名皆適用。

## 11. 前端知識頁

`apps/web/src/routes/staging-sync-guide.tsx`（react-router 受保護路由 `/staging-sync-guide`，
`router.tsx` 註冊、`header.tsx` 加 `NavLink`）分五節：1. 兩難說明、2. 架構圖、3. 狀態機圖（皆
內嵌 SVG，不引新依賴）、4. 關鍵設計卡片（鎖 vs fencing、partial unique index 最後防線）、
5. 即時演示區；串 `hooks/use-staging-sync-guide.ts`（輪詢 runs、載入 catalog、`trigger`／
`abandon`／mock 模式切換，內部呼叫 `lib/staging-sync-api.ts` 的 6 支 API 函式），提供「觸發
同步／切換 mock 模式／放棄 staged 執行／查看目前生效目錄」操作按鈕。

## 12. 教學重點問答

| Q | 答案摘要 | 詳見 |
| --- | --- | --- |
| 天真分批 commit 為何看起來「資料被刪一半」？ | mark 已先執行，sweep 卻拆成多筆獨立交易，中途失敗就卡在半調子的不一致狀態 | §1 |
| staging＋單一交易切換為何能兼顧記憶體與原子性？ | Phase 1 逐頁寫 staging 封頂記憶體；Phase 2 待資料齊全才單一交易合併，原子性交給資料庫 | §1、§5 |
| 為什麼 advisory lock 不夠，還要 fencing？ | 鎖是連線屬性，斷線自動釋放但持鎖 worker 未必真的停止；**鎖＝誰先開始，fencing＝誰現在還算數** | §2 決策 3-4 |
| partial unique index 如何做為最後防線？ | 建在資料庫層，不依賴任何應用層邏輯；即使鎖與狀態機被繞過，insert 仍會撞 `23505` 被拒絕 | §2 決策 5 |
| 為什麼合併要用來源業務鍵而非本地主鍵？ | 全量刷新每輪都可能整批換一輪本地 PK 世代，用本地 PK 關聯下一輪同步後就會對不上 | §2 決策 6 |
| swap 失敗後為何能不重抓、直接重播？ | 失敗只 rollback「合併」這個動作，staging 資料早已獨立提交；`recoverActiveRun` 直接重播 Phase 2 | §2 決策 7、§4 |
| 撕裂快照與錯誤遮蔽是怎麼被抓到的？ | 都是完成後多代理審查、用真實 Postgres 重現才發現；共通教訓——收尾動作沒搞清楚隔離級語意或呼叫順序會製造新陷阱 | §5、§7 |

## 13. 程式風格約束（沿用專案慣例）

繁中註解、雙引號＋分號＋printWidth 100、`import type`、`noUncheckedIndexedAccess`（索引取值
處理 undefined）、無未用變數、全 ESM、Fastify route 群組 `export async function xxxRoutes(app)`、
zod v4（`z.url()` 頂層函式）；raw SQL 一律經 `drizzle-orm` 的 `sql`／`sql.identifier` 組出，
不手刻字串拼接欄位／表名。
