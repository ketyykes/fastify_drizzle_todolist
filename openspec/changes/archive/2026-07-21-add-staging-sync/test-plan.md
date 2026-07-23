# Test Plan: add-staging-sync

<!--
  RED-phase 委諾文件。本 change 尚未實作，下表為「先寫測試」的規劃版本。
  後端整合測試以 Fastify app.inject()（或起真實 port 供 fetcher 打 HTTP，
  比照 todos.test.ts 的 app.listen({ port: 0 }) 做法）對測試用 Postgres 驗證；
  前端 hook 測試以 mock lib/staging-sync-api 模組驗證狀態管理，屬 unit。
  Tier 欄位每列必填（unit | integration | e2e）。
-->

## staging-sync

### Requirement: 同步類型同時僅能有一個進行中執行（持久 invariant）

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `同 sync_type 兩個進行中執行撞 23505 並轉譯為可識別錯誤`（`schema.test.ts`） | 嘗試建立第二個進行中執行遭資料庫拒絕 | 已有一筆 `fetching` 執行時，插入同 `syncType` 第二筆進行中執行 → 資料庫回 23505，`run-manager` 轉譯為 `ActiveSyncRunError` | golden path，這是全案最後防線的持久 invariant | integration |
| `已結束狀態的多筆執行可共存`（`schema.test.ts`） | 已結束狀態的執行可與新的進行中執行共存 | 同 `syncType` 已有多筆 `done`/`fetch_failed`/`abandoned` 歷史列 → 仍可新增一筆進行中執行，不受影響 | 邊界：partial index 只約束進行中狀態 | integration |
| `manifest 宣告的目標表／暫存表／conflict key 欄位與實際 schema 一致`（`schema.test.ts`） | 合併採用來源業務鍵而非本地主鍵作為比對依據 | 逐表比對 `manifest.ts` 宣告的欄位與 drizzle schema 定義 → 完全一致，缺漏或多餘欄位視為測試失敗 | 底層機制：merger/writer/測試共用同一份 manifest，若與 schema 不一致會在執行期才爆炸 | unit |

### Requirement: Advisory lock 互斥保護單一同步流程

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `兩個並發請求只有一個取得鎖，另一個立即得到衝突結果`（`mutex.test.ts`） | 兩個並發觸發只有一個成功取得鎖 | 同一 `syncType` 兩次幾乎同時 `acquireSyncLock` → 僅一次成功，另一次立即回傳鎖衝突（不等待） | golden path | integration |
| `release 後可再次取得，證明鎖與同一 client 綁定`（`mutex.test.ts`） | 鎖釋放後可再次取得 | 第一次取得後呼叫 `release()`，再次 `acquireSyncLock` 同一 `syncType` → 成功取得 | golden path，同時驗證 release 用同一 client 生效 | integration |
| `pg_advisory_unlock 回傳 false 時記錄警告但不拋出`（`mutex.test.ts`） | 解鎖失敗時記錄警告但不影響流程結果 | 模擬 unlock 回傳 false（並未持有鎖）→ 記錄 structured warning，`release()` 本身不拋出例外 | 安全邊界：釋放失敗不可拖累呼叫端 | unit |

### Requirement: sync_runs 狀態機與 fencing 保護狀態轉移

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `合法狀態依序轉移：fetching→staged→swapping→done`（`run-manager.test.ts`） | 合法狀態依序轉移 | 依序呼叫 `startFetching`→`markStaged`→`claimForSwap`→`completeInsideTransaction` → 每步後查詢 `phase` 依序正確 | golden path | integration |
| `每個狀態轉移方法在 fence 不符時皆拒絕`（`run-manager.test.ts`） | fencing 憑證不符時狀態轉移遭拒絕 | 對 `markStaged`/`claimForSwap`/`completeInsideTransaction`/`failPhaseOne`/`returnSwapToStaged` 各自帶入錯誤的 `ownerToken` 或 `leaseVersion` → 皆拋 `FenceLostError`，狀態不變（逐方法各一案例） | 安全邊界：fencing 是本案核心保護，需逐一窮舉 | integration |
| `recoverActiveRun：殘留 fetching 判定為 fetch_failed`（`run-manager.test.ts`） | 復原殘留的 fetching 執行判定為失敗 | 建一筆殘留 `fetching` 執行 → `recoverActiveRun` 後其 `phase` 為 `fetch_failed` | golden path（復原三分支之一） | integration |
| `recoverActiveRun：殘留 swapping 退回 staged 且 leaseVersion 遞增`（`run-manager.test.ts`） | 復原殘留的 swapping 執行退回 staged 並可重播 | 建一筆殘留 `swapping` 執行 → `recoverActiveRun` 後其 `phase` 為 `staged`，`leaseVersion` 較前一版本大 1 | golden path（復原三分支之二） | integration |
| `recoverActiveRun：殘留 staged 原樣回傳供重播`（`run-manager.test.ts`） | 復原殘留的 staged 執行原樣可重播 | 建一筆殘留 `staged` 執行 → `recoverActiveRun` 回傳同一筆執行，`phase` 不變 | golden path（復原三分支之三） | integration |
| `abandon 僅限 staged：狀態轉為 abandoned 並記錄操作者與原因`（`run-manager.test.ts`） | 僅 staged 狀態可被人工放棄 | 對一筆 `staged` 執行呼叫 `abandon(operator, reason)` → `phase` 為 `abandoned`，`abandonedBy`/`abandonedReason` 正確記錄 | golden path | integration |
| `abandon 對非 staged 狀態拒絕`（`run-manager.test.ts`） | 非 staged 狀態嘗試放棄遭拒絕 | 對一筆 `fetching`/`done` 執行呼叫 `abandon` → 拋出錯誤，狀態不變 | 邊界：放棄操作的狀態守門 | integration |

### Requirement: 逐頁惰性抓取來源資料

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `逐頁惰性產生，呼叫端消費一頁前不預先抓取下一頁`（`page-fetcher.test.ts`） | 逐頁抓取不預先累積全部資料 | 消費 generator 一頁後暫停 → 驗證尚未對下一頁發出請求（以呼叫次數斷言） | golden path，核心設計決策 | integration |
| `count < pageSize 時終止抓取`（`page-fetcher.test.ts`） | 回傳筆數小於分頁大小視為最後一頁 | mock source 回傳筆數小於 `pageSize` 的一頁 → 抓取流程於此頁後結束，未再請求下一頁 | golden path | integration |
| `剛好整頁時允許最後一次空頁請求`（`page-fetcher.test.ts`） | 剛好整頁時允許最後一次空頁請求 | 總筆數恰好是 `pageSize` 整數倍 → 抓取流程在最後一頁後多請求一次確認空集合才終止 | 邊界：分頁終止條件的關鍵陷阱 | integration |
| `flaky_page_2：第一次 500，重試後成功`（`page-fetcher.test.ts`） | 單頁暫時性錯誤重試後成功 | mock source 模式 `flaky_page_2` → 第 2 頁第一次失敗、重試後成功取得，整體抓取不中斷 | golden path | integration |
| `fail_page_2：重試耗盡仍失敗，拋出 SourceFetchError`（`page-fetcher.test.ts`） | 單頁錯誤重試耗盡後拋出例外 | mock source 模式 `fail_page_2` → 重試達上限仍失敗 → 拋出 `SourceFetchError`，終止抓取 | 安全邊界：不可無限重試 | integration |
| `4xx 不重試直接拋出`（`page-fetcher.test.ts`） | 用戶端錯誤不重試直接拋出例外 | mock source 回傳 4xx → 立即拋出例外，未觸發任何重試（以呼叫次數斷言為 1） | 邊界：4xx 與 5xx 的重試策略必須不同 | integration |

### Requirement: 單頁資料攤平為關聯緩衝

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `巢狀資料正確攤平成三組緩衝`（`page-transformer.test.ts`） | 巢狀資料正確攤平成三組緩衝 | 一頁含多筆清單、各自多個項目與標籤 → 攤平後三組緩衝內容與巢狀結構一致 | golden path | unit |
| `同頁重複業務鍵 last-row-wins`（`page-transformer.test.ts`） | 同頁重複鍵值以最後一筆為準 | 同頁出現兩筆相同業務鍵、內容不同的資料 → 緩衝只保留最後一筆 | 邊界：教學重點之一（跨頁/同頁重複的處理原則） | unit |
| `空頁仍初始化三組緩衝為空集合`（`page-transformer.test.ts`） | 空頁仍初始化三組緩衝為空集合 | 傳入不含任何資料的頁 → 回傳三組緩衝皆為空集合而非 `undefined` | 邊界：避免呼叫端對 `undefined` 誤判 | unit |

### Requirement: 逐頁寫入暫存表並更新進度檢查點

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `fence 失效時拒絕寫入，暫存表與檢查點皆不受影響`（`staging-writer.test.ts`） | fencing 憑證失效時拒絕寫入 | 帶入不符的 fence 呼叫 `writePage` → 拋錯，暫存表無新增列、進度檢查點未更新 | 安全邊界 | integration |
| `寫入成功後於同交易更新進度檢查點`（`staging-writer.test.ts`） | 寫入成功後更新進度檢查點 | 成功 `writePage` 後 → `lastOffset`/`pageCount`/`sourceCount`/`stagedCounts`/`heartbeatAt` 皆正確更新 | golden path | integration |
| `不同執行的暫存資料以 sync_run_id 隔離`（`staging-writer.test.ts`） | 不同執行的暫存資料互不影響 | 兩個不同執行各自寫入相同業務鍵的資料 → 個別暫存表內各自保留一筆，互不覆蓋 | 邊界：run 隔離正確性 | integration |
| `跨頁重複業務鍵 upsert 具冪等性（overlap 情境）`（`staging-writer.test.ts`） | 跨頁重複鍵值寫入具冪等性 | 同一執行內第 2 頁重複第 1 頁最後一筆業務鍵（模擬 `overlap=1`）→ 暫存表僅保留一筆，寫入不報錯 | golden path，直接對應 `overlap` 測試情境 | integration |

### Requirement: 原子切換：標記非啟用後以業務鍵合併復活

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `暫存不存在的舊資料標記為 is_active=false`（`merger.test.ts`） | 暫存已不存在的舊資料被標記為非啟用 | 目標表既有一筆資料，其業務鍵未出現在本次暫存表 → 切換後 `is_active` 為 `false`，資料仍存在 | golden path | integration |
| `暫存存在的資料復活且欄位更新為最新值`（`merger.test.ts`） | 暫存存在的資料復活且欄位更新為最新值 | 暫存表一筆資料業務鍵已存在於目標表（原 `is_active` 為任意值）→ 切換後 `is_active=true` 且欄位為暫存最新值 | golden path | integration |
| `合併以業務鍵而非本地主鍵比對，PK 世代改變不影響結果`（`merger.test.ts`） | 合併採用來源業務鍵而非本地主鍵作為比對依據 | 模擬兩輪同步間本地自增主鍵不同世代 → 第二輪合併仍正確對應到同一筆邏輯資料，無孤兒或重複 | golden path，核心教學重點 | integration |

### Requirement: 衍生欄位於切換交易內集合式重算

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `依 priority 降冪、source_item_id 升冪重算 position`（`merger.test.ts`） | 依決定性排序規則重新計算衍生欄位 | 同一 `source_list_id` 分組多筆啟用項目、`priority` 不同 → 重算後 `position` 依序為 1、2、3…… | golden path | integration |
| `非啟用項目的 position 維持舊值不參與重算`（`merger.test.ts`） | 僅重算啟用中的資料，非啟用資料維持舊值 | 某筆項目本次同步後 `is_active=false` → 其 `position` 與切換前相同 | 邊界：重算範圍守門 | integration |
| `singleton 分組的 position 為 1`（`merger.test.ts`） | 單筆資料的分組也從 1 開始編號 | 某 `source_list_id` 分組僅一筆啟用項目 → `position` 為 1 | 邊界：起始值正確性 | integration |

### Requirement: 切換失敗可回滾並在下次觸發時重播暫存資料

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `failureInjector 於 mark/merge/position 各階段注入 → 整體回滾`（`merger.test.ts`） | 切換過程中任一階段中斷則整體回滾 | 對 `after_mark:<table>`／`after_merge:<table>`／`after_positions` 各 hook 注入錯誤 → 目標表回到切換前狀態，暫存表資料不變（逐 hook 各一案例） | 安全邊界：模擬中途崩潰是本案風險最高的路徑 | integration |
| `回滾後執行退回 staged 且暫存資料保留`（`merger.test.ts`） | 回滾後執行狀態退回可重播的狀態 | 上述任一 failureInjector 情境後 → 該執行 `phase` 為 `staged`，暫存表資料筆數不變 | golden path（回滾後續） | integration |
| `swap 失敗後下次 dispatch 直接重播，mock source 零額外請求`（`dispatcher.test.ts`） | 重新播放時不重新抓取來源資料 | 先製造一次切換失敗，再次觸發 `runTemplateCatalogSync` → 以 mock source 請求計數斷言為 0（未發出任何新的抓取請求），且切換最終成功完成 | golden path，端到端證明「不重新抓」 | integration |

### Requirement: 背景清理保留期限外的暫存與執行紀錄

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `done 執行的暫存資料逾 1 日被清除`（`pruner.test.ts`） | 已完成執行的暫存資料逾保留期限被清除 | 一筆 `done` 執行的 `finishedAt` 早於 1 日前 → 其暫存表資料被清除，新鮮的 `done` 不受影響 | golden path | integration |
| `fetch_failed/abandoned 的暫存資料逾 7 日被清除`（`pruner.test.ts`） | 失敗或已放棄執行的暫存資料逾較長保留期限被清除 | 一筆 `fetch_failed`／`abandoned` 執行早於 7 日前 → 其暫存表資料被清除 | golden path | integration |
| `終態執行紀錄逾 90 日本身被刪除`（`pruner.test.ts`） | 已結束執行本身逾最長保留期限被刪除 | 一筆終態執行早於 90 日前 → 該筆 `sync_runs` 列本身被刪除 | golden path | integration |
| `進行中執行（含逾期）不受任何清理影響`（`pruner.test.ts`） | 進行中的執行不受清理影響 | 一筆 `fetching`/`staged`/`swapping` 執行即使 `startedAt` 已逾 90 日 → 清理後仍完整存在 | 安全邊界：清理絕不可誤傷進行中執行 | integration |
| `重複執行清理具冪等性，計數不重複`（`pruner.test.ts`） | 重複執行清理具冪等性 | 對同一批已清除資料再次執行 `pruneStagingSyncRuns` → 不報錯，回傳的清理筆數為 0 | 邊界：CLI 可能被重複呼叫 | integration |

### Requirement: 一次完整同步流程的協調（dispatcher）

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `happy path：完整跑完兩階段並回傳結果摘要`（`dispatcher.test.ts`） | 正常情況完整跑完兩階段並回傳結果摘要 | mock source 模式 `success` → 回傳含 `runId`/`resultCode`/`phase`/`pageCount`/`sourceCount`/`stagedCounts`/`fetchSeconds`/`swapSeconds` 的結果摘要，目標表資料正確刷新 | golden path，一次驗證整條流程 | integration |
| `no_data：來源空集合，不執行切換，目標表不受影響`（`dispatcher.test.ts`） | 來源沒有資料時回傳無資料結果 | mock source 模式 `empty` → 結果碼為 `no_data`，未觸發切換，目標表維持觸發前狀態 | edge case | integration |
| `fetch 失敗：目標表零變更，執行標記為 fetch_failed`（`dispatcher.test.ts`） | 抓取失敗時目標資料表不受任何變更 | mock source 模式 `fail` → 執行 `phase` 為 `fetch_failed`，目標表 3 張表內容與觸發前逐列比對完全相同 | 安全邊界：核心原子性保證 | integration |
| `兩個並發 trigger 只有一個成功，另一個鎖衝突`（`dispatcher.test.ts`） | 兩個並發觸發只有一個成功執行其餘遭鎖衝突拒絕 | 同時呼叫兩次 `runTemplateCatalogSync` → 一次完整完成，另一次立即回傳鎖衝突且未執行任何抓取/寫入 | 安全邊界：併發互斥的端到端驗證 | integration |

### Requirement: 模擬來源服務供教學與測試使用

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `相同查詢參數重複呼叫回應內容完全一致`（`routes/mock-source.test.ts`） | 分頁資料決定性生成 | 以相同 `limit`/`offset`/`total` 重複呼叫 → 每次回應逐位元組相同 | golden path | integration |
| `overlap=1 時第 2 頁頁首重複前一頁末筆`（`routes/mock-source.test.ts`） | 分頁重疊模擬 offset 漂移 | 帶 `overlap=1` 查詢第 2 頁 → 頁首第一筆與第 1 頁最後一筆內容相同 | golden path，直接對應 staging 冪等性測試的資料來源 | integration |
| `mode 切換：success/fail/fail_page_2/flaky_page_2/empty 各自行為正確`（`routes/mock-source.test.ts`） | 可切換失敗模式模擬各種故障情境 | `PUT /mock-source/mode` 切換各模式後查詢分頁端點 → 回應分別符合成功、全部失敗、指定頁失敗、指定頁重試成功、空集合的定義 | golden path，五個模式各一案例 | integration |
| `reset 端點清空狀態並恢復預設模式`（`routes/mock-source.test.ts`） | 重置狀態恢復預設模式 | 切換至非預設模式後呼叫 `POST /mock-source/reset` → 模式回到 `success`，內部狀態清除 | golden path | integration |

### Requirement: 維運端點：觸發、查詢、放棄與查詢目錄

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `未登入呼叫四支端點皆回 401`（`routes/staging-sync-admin.test.ts`） | 未登入呼叫維運端點回 401 | 未帶 token 呼叫觸發/查詢執行/放棄/查詢目錄四支端點 → 皆回 401 | 安全邊界 | integration |
| `觸發同步完成回傳 200 與結果摘要`（`routes/staging-sync-admin.test.ts`） | 觸發同步完成回傳結果摘要 | 已登入呼叫觸發端點、mock source 為 `success` → 200，body 為結果摘要且不含 `ownerToken` | golden path | integration |
| `觸發時鎖衝突或既有進行中執行回 409`（`routes/staging-sync-admin.test.ts`） | 觸發時鎖衝突或既有進行中執行回傳 409 | 已存在進行中執行時再次呼叫觸發端點 → 409 | 邊界 | integration |
| `觸發時鎖層錯誤回 503`（`routes/staging-sync-admin.test.ts`） | 觸發時鎖層錯誤回傳 503 | 模擬取得 advisory lock 的資料庫操作本身出錯 → 503 | 邊界 | integration |
| `查詢近期執行列表不含 ownerToken`（`routes/staging-sync-admin.test.ts`） | 查詢近期執行紀錄不外洩鎖憑證 | `GET` 近期執行列表 → 回傳陣列每筆皆不含 `ownerToken` 欄位 | 安全邊界 | integration |
| `放棄 staged 執行成功`（`routes/staging-sync-admin.test.ts`） | 放棄僅限 staged 狀態的執行 | 對一筆 `staged` 執行呼叫放棄端點並帶 `reason` → 200，該執行轉為 `abandoned` | golden path | integration |
| `放棄非 staged 執行回 422`（`routes/staging-sync-admin.test.ts`） | 非 staged 狀態放棄請求回傳 422 | 對一筆 `done`/`fetching` 執行呼叫放棄端點 → 422，狀態不變 | 邊界 | integration |
| `查詢目錄回傳依 position 排序的巢狀資料`（`routes/staging-sync-admin.test.ts`） | 查詢目前生效目錄回傳巢狀排序資料 | 完成一次同步後 `GET` 目錄端點 → 回傳清單/項目（依 `position` 排序）/標籤的巢狀組合，僅含 `is_active` 資料 | golden path | integration |

### Requirement: 維運 CLI

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `staging-sync-run：成功/無資料/失敗結束碼分別為 0/2/1`（`scripts/staging-sync-cli.test.ts`） | 執行一次同步指令依結果回傳對應結束碼 | 分別在 mock source 為 `success`/`empty`/`fail` 模式下執行 CLI → 結束碼依序 0、2、1，皆輸出 JSON 結果摘要 | golden path + 邊界（三案例） | integration |
| `staging-sync-status：輸出最近 N 筆執行摘要`（`scripts/staging-sync-cli.test.ts`） | 查詢近期執行紀錄指令 | 執行 CLI 帶 `--limit=5` → 輸出最多 5 筆執行摘要，依時間新到舊 | golden path | integration |
| `staging-sync-abandon：對非 staged 執行報錯退出`（`scripts/staging-sync-cli.test.ts`） | 人工放棄指令僅限 staged 狀態 | 指定一筆 `done` 狀態執行 id 執行放棄 CLI → 非 0 結束碼，該執行狀態不變 | 驗證守門 | integration |
| `staging-sync-abandon：對 staged 執行成功放棄`（`scripts/staging-sync-cli.test.ts`） | 人工放棄指令僅限 staged 狀態 | 指定一筆 `staged` 狀態執行 id 並帶 `--reason=...` → 結束碼 0，該執行轉為 `abandoned` | golden path | integration |
| `staging-sync-prune：輸出各項清理筆數`（`scripts/staging-sync-cli.test.ts`） | 清理保留期限指令 | 建立各保留期限邊界的測試資料後執行 prune CLI → 結束碼 0，輸出的清理筆數與實際變化一致 | golden path | integration |

### Requirement: 前端教學頁：觸發、觀察、放棄

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `loads_runs_successfully`（`use-staging-sync.test.tsx`） | 顯示近期執行列表與各自狀態 | 頁面載入時呼叫查詢執行列表 API → `runs` 更新為回傳值，`loading` 變 false | golden path | unit |
| `sets_error_on_fetch_failure`（`use-staging-sync.test.tsx`） | 顯示近期執行列表與各自狀態 | 查詢執行列表 API 拋錯 → `error` 被設定，不拋出未捕捉例外 | 安全邊界：讀取失敗不可讓頁面整體崩潰 | unit |
| `trigger_calls_api_and_refetches_runs`（`use-staging-sync.test.tsx`） | 觸發同步並顯示結果摘要 | 呼叫 `trigger` → 呼叫觸發同步 API，成功後 `lastResult` 更新且重新呼叫查詢執行列表 API | golden path | unit |
| `abandon_calls_api_and_refetches_runs`（`use-staging-sync.test.tsx`） | 放棄 staged 執行並重新整理列表 | 呼叫 `abandon(runId, reason)` → 呼叫放棄 API，成功後重新呼叫查詢執行列表 API | golden path | unit |
| `loads_catalog_successfully`（`use-staging-sync.test.tsx`） | 顯示目前生效目錄 | 頁面載入時呼叫查詢目錄 API → `catalog` 更新為回傳的巢狀資料 | golden path | unit |

測試需要在真實埠上提供 mock-source（fetcher 用全域 fetch）：比照 `todos.test.ts` 的做法 `app.listen({ port: 0 })` 後把 config 的 `sourceUrl` 指向 ephemeral port。

---

## Checklist

- [x] Every requirement has at least one matching test
- [x] Every Scenario (####) has at least one matching test
- [x] Every row has a Tier value (unit | integration | e2e)
- [x] Test names use imperative form or reflect the planned `.test.ts` description text
