# Design: add-staging-sync

## Context

本專案（`fastify_drizzle_todolist`，pnpm monorepo：`apps/web` React + react-router、`apps/server` Fastify 5 + Drizzle + zod、`packages/db`、`packages/env`）已有 `add-todolist-mvp` 的登入與 per-user todos CRUD，以及 `add-transactional-outbox` 示範的「本地交易＋外部 HTTP 不可原子化」教學情境。這個 change 疊加另一個獨立、同樣是治本模式的教學情境：**大量外部資料同步**。

情境設定：一個 mock 範本庫（template catalog provider）服務以分頁形式回傳巢狀資料（範本清單→項目→標籤），本地需要定期把這份清單「全量刷新」——舊資料要能被正確標記為不存在、新資料要能正確寫入或更新、過程中衍生欄位（如排序位置）要重新計算。這正是「一次全載入記憶體會 OOM，天真分批 commit 會破壞原子性」兩難最典型的場景。

本 change 是**尚待實作的規劃文件**：以下所有 artifact 皆為實作前的設計依據，唯一權威來源是設計簡報（本文件依其整理，不逐字複製，決策取捨與原文一致）。

## Goals

- 示範「逐頁抓取 → staging 暫存表 → 單一交易原子切換（mark-and-sweep）」完整生命週期，證明這個模式能同時封頂記憶體用量、又保住全量刷新的原子性。
- 示範 `sync_runs` 狀態機搭配 advisory lock 與 owner_token/lease_version fencing，說明「鎖只能防止並發啟動，防不了鎖釋放後仍在運作的舊 worker」這個常被忽略的併發陷阱。
- 示範 partial unique index 作為「最後防線」的持久 invariant，即使應用層的鎖與狀態機邏輯都失靈，資料庫本身仍能擋下第二個並行執行。
- 示範合併資料時必須用「來源業務鍵」而非本地自增主鍵，否則全量刷新換過一輪 PK 世代後，任何用本地 PK 做外部關聯的資料都會變成孤兒。
- 讓開發者能透過前端頁面與 CLI 實際觸發、觀察狀態流轉（分頁進度、切換結果、放棄 staged 執行），而不只是讀文件。
- 完全去識別化：不出現任何來源系統名稱，情境一律以「mock 範本庫分頁 API → 本地目錄」描述。

## Non-Goals

- 不做多 `sync_type` 的通用排程調度／事件匯流排；`manifest.ts` 雖抽成通用結構供未來擴充，本 change 只落地 `template_catalog` 一種類型。
- 不引入常駐 worker 或排程框架讓 `pruner` 自動定期執行；比照維運 CLI 由人工或外部排程（cron／CI）觸發，不在本 change 內建置排程基礎設施。
- 不追求「切換期間寫入不受影響」；切換交易持有目標表大量列鎖，期間其他寫入者會等待 commit。讀取者因 PostgreSQL MVCC 不受影響，不會看到中間態（見 Risks）。
- 不引入分散式鎖元件（Redis 等）；PostgreSQL 原生的 session advisory lock 已足夠，且與本專案「最小依賴」的一貫取向一致。
- 不做「剛好一次」（exactly-once）的來源抓取語意；`overlap=1` 模擬的分頁重疊由 staging upsert 的冪等性吸收，不追求來源分頁本身零重疊。

## Decisions

### Decision: 逐頁抓取 + staging 暫存表 + 單一交易原子切換，取代全量載入記憶體或天真分批 commit

**Choice**: `page-fetcher.ts` 以 async generator 惰性逐頁抓取，每頁立即攤平寫入 staging 表（各自獨立短交易）；等所有頁都寫完，才在**單一交易**內把 staging 資料合併回目標表（mark-and-sweep：先全部標記非啟用，再依 staging 內容 upsert 復活並更新欄位）。

**Rationale**: 全量載入記憶體的問題是資料量與 process 記憶體成正比，資料集夠大必然 OOM；天真分批 commit（每頁抓完就對目標表 commit 一次）的問題是把一個天生需要原子性的操作切成多筆獨立交易，任何一筆中途失敗，使用者看到的就是「資料被刪掉一半」的假象。staging 暫存表把「封頂記憶體」與「保住原子性」這兩個目標解耦：抓取階段可以無限逐頁、記憶體用量只跟單頁大小成正比；提交階段則退回成一個資料庫早已優化過的單一交易操作。

**Alternatives considered**:
- 全量載入記憶體、排序/去重後一次寫入：實作最簡單，但資料量放大到一定程度必然 OOM，且完全無法優雅降級。
- 每頁一個獨立交易直接寫目標表（天真分批 commit）：確實封頂了記憶體，但失去原子性——中途失敗會讓目標表處於「部分已刷新、部分還是舊資料」的不一致狀態，且沒有簡單的方法回到刷新前的狀態。

### Decision: `sync_runs` 狀態機 + owner_token/lease_version fencing，不只靠 advisory lock

**Choice**: 除了用 advisory lock 保護「同一時間只有一個 worker 在跑同步」，每個 `sync_runs` 執行還持有一組 `owner_token`（uuid）與 `lease_version`（遞增整數）；`run-manager.ts` 的每一個狀態轉移方法都要求呼叫端帶入這組憑證（`SyncRunFence`），並用 `WHERE id AND phase AND owner_token AND lease_version` 的條件式更新驗證後才生效，不符即拋 `FenceLostError`。

**Rationale**: advisory lock 綁定在單一資料庫連線（session）上；連線斷線（網路問題、process 被中斷但沒能正常 release）時鎖會自動釋放，但持有那條連線的 worker 有可能還沒真正停止、仍在背景繼續嘗試寫入。單靠鎖無法分辨「這個寫入是不是來自已經失去鎖的舊 worker」；fencing token 讓每一次寫入都必須證明自己仍是「當下合法」的執行者，鎖只解決「誰先開始」，fencing 解決「誰現在還算數」。

**Alternatives considered**:
- 只依賴 advisory lock、不做 fencing：實作更簡單，但完全無法防禦「鎖釋放後舊 worker 仍嘗試寫入」的競態，教學上會漏掉一個關鍵陷阱。
- 用交易隔離等級（如 `SERIALIZABLE`）取代 fencing：解決的是併發交易間的可見性問題，不是「跨交易、跨連線的過期執行者」問題，兩者層次不同，不能互相取代。

### Decision: PostgreSQL session advisory lock（`pg_try_advisory_lock`，綁專用 client），取代應用層分散式鎖

**Choice**: `mutex.ts` 從連線池另外借出一個**專用 client**（非透過 ORM 的連線池自動配對），執行 `pg_try_advisory_lock(hashtext('staging_sync'), hashtext($syncType))`；release 時必須用同一個 client 執行 `pg_advisory_unlock`，並全程 `finally` 歸還 client。

**Rationale**: PostgreSQL 的 session advisory lock 天生綁定在取得鎖的那個連線（session）上，這是它「連線斷線即自動釋放」特性的來源，也是本設計刻意用它來教學 fencing 必要性的原因。若透過 ORM 的連線池隨機配對取得/釋放鎖的兩次呼叫，可能落在不同實體連線上，導致釋放失敗或釋放了別人持有的鎖；因此必須手動管理一個專用 client 貫穿鎖的整個生命週期。

**Alternatives considered**:
- 應用層分散式鎖（Redis `SETNX` 等）：需要額外的基礎設施依賴，對「最小依賴」的教學範例不成比例，且失去「鎖與連線生命週期綁定」這個示範重點。
- Transaction-level advisory lock（`pg_advisory_xact_lock`，交易結束自動釋放）：生命週期綁定交易而非連線，但本設計的鎖需要橫跨整個 Phase 1（多頁、多筆短交易）與 Phase 2（單一交易），沒有一個單一交易能涵蓋全程，因此必須用 session-level 版本。

### Decision: partial unique index 作為「同步類型同時只能有一個進行中執行」的持久 invariant

**Choice**: `sync_runs` 建立 `uq_sync_runs_active`：`uniqueIndex('uq_sync_runs_active').on(syncType).where(phase IN ('fetching','staged','swapping'))`。任何試圖為同一 `syncType` 建立第二個進行中執行的 insert 會撞 `23505`，由 `run-manager.ts` 轉譯為 `ActiveSyncRunError`。

**Rationale**: advisory lock 與狀態機邏輯都是「應用層」的保護，一旦有程式碼路徑忘記檢查（例如新增一支繞過 `dispatcher.ts` 直接呼叫 `startFetching` 的維運腳本），這些保護都可能被繞過。partial unique index 是資料庫原生、無法被應用層邏輯疏漏繞過的最後一道防線；PostgreSQL 原生支援 partial index，比一般 UNIQUE 加額外的 generated column 更乾淨。

**Alternatives considered**:
- 只靠 advisory lock 防止並發啟動：對「透過 dispatcher 正常觸發」的路徑足夠，但無法防禦任何繞過鎖直接寫 `sync_runs` 的路徑（人為操作失誤、未來維運腳本疏漏）。
- 應用層在 insert 前先查詢是否已有進行中執行（check-then-act）：本身就是一個典型的競態窗口，precisely 是本專案「編號產生／併發競態家族」已知技術債的同根因寫法，不應該再示範一次。

### Decision: 合併時以「來源業務鍵」為 conflict target，不用本地自增主鍵

**Choice**: staging 表與目標表之間的 upsert（`INSERT ... ON CONFLICT (來源業務鍵欄位) DO UPDATE`）一律用來源系統的業務鍵（`source_list_id`、`source_item_id`、`(source_item_id, tag)`）做 conflict target；`template_items.source_list_id` 這個關聯欄位也存業務鍵，不存本地 `template_lists.id`。

**Rationale**: 全量刷新的本質是「每次同步都可能整批換一輪本地自增主鍵」；如果任何關聯欄位或合併邏輯用本地 PK 做依據，下一輪同步後這些依據就全部失效，用本地 PK join 的查詢會看到大量「孤兒」（本應存在的關聯全部對不上）。用來源業務鍵做合併與關聯，才能保證跨多輪同步的資料一致性與可追蹤性。

**Alternatives considered**:
- 用本地自增主鍵做 conflict target 與外部關聯：實作上更符合關聯式資料庫直覺（FK 指向本地 PK），但完全撐不住「全量刷新換 PK 世代」這個場景，是本專案在真實情境中已反覆驗證過的系統性根因，教學範例必須正面示範正確做法而非重蹈覆轍。

### Decision: mark-and-sweep 語意（全表標記非啟用 → 依 staging 內容合併復活），而非逐筆 diff 再刪除

**Choice**: 切換交易內先對 3 張目標表整批 `UPDATE SET is_active=false`，再依 staging 表逐筆 upsert：staging 有的資料復活（`is_active=true`）並更新欄位，staging 沒有的資料維持 `is_active=false`（軟刪除，非硬刪除）。

**Rationale**: mark-and-sweep 是「先假設全部過期，再讓證據（staging 內容）證明哪些仍然有效」的語意，天然對應「全量刷新」的意圖，且用軟刪除（`is_active` 欄位）保留歷史資料可稽核，不會因為單次同步的資料缺漏就永久遺失本地紀錄。這個模式也是同一單一交易內完成，不需要額外的 diff 計算階段。

**Alternatives considered**:
- 逐筆比對 staging 與目標表算出差異（新增/更新/刪除三個集合）再分別執行：需要額外的比對邏輯與更多次查詢，且對「全量」語意而言，`mark-and-sweep` 已經是等價但更簡單的實作。
- 直接硬刪除目標表中 staging 沒有的資料：喪失歷史稽核能力，且一旦某次同步意外抓到不完整的來源資料（如來源服務故障回傳空集合而非直接視為 `no_data`），會造成無法復原的資料遺失。

### Decision: 衍生欄位（`template_items.position`）於切換交易內以 set-based SQL 集合式重算

**Choice**: `merger.ts` 在同一筆切換交易內，用 `ROW_NUMBER() OVER (PARTITION BY source_list_id ORDER BY priority DESC, source_item_id ASC)` 對所有 `is_active = true` 的項目重新計算 `position`，只處理啟用中的項目，非啟用項目維持舊值。

**Rationale**: `position` 是由 `priority` 推導出的排序位置，不能來自來源系統（`priority` 才是來源系統送來的原始值），必須在合併完成、`is_active` 狀態底定之後，於同一交易內一次性重算，否則會與剛完成的合併結果不一致。用 `ROW_NUMBER()` 集合式運算比逐筆迴圈計算更符合資料庫的操作方式，也更容易寫出決定性（deterministic）結果——這對測試「singleton 也必須是 1」「同 partition 從 1 開始」這類邊界特別重要。

**Alternatives considered**:
- 應用層迴圈逐筆計算並個別 UPDATE：多出大量往返查詢，且需要額外處理排序穩定性（tie-breaker），set-based SQL 原生就能用次要排序鍵決定順序。
- 允許並列（相同 `priority` 給相同 `position`）：拿掉了決定性 tie-breaker，多筆資料會共用同一個 position，違反「position 是排序位置」的語意，且測試無法窮舉驗證。

### Decision: 切換失敗後直接讓下次觸發重播 staged 資料，不重新抓取來源

**Choice**: `merger.swap` 若在切換交易內失敗（`failureInjector` 模擬中途崩潰的各個 hook），rollback 整筆交易、呼叫 `run-manager.ts` 的 `returnSwapToStaged`（狀態退回 `staged`，保留原 fence）而不清除已寫入的 staging 資料；下次 `dispatcher` 觸發時，`recoverActiveRun` 偵測到殘留 `staged` 執行會直接跳過 Phase 1、直接重播 Phase 2。

**Rationale**: 切換失敗通常是資料庫層面的暫時性問題（鎖等待逾時、約束衝突等），與「來源資料是否需要重新抓取」無關；staging 資料在切換失敗當下仍然完整有效，重新抓一次來源不僅浪費頻寬與時間，也違背「分批的是記憶體，不是 commit」這個原則的延伸——已經封頂記憶體抓到的資料不該被平白丟棄重來。

**Alternatives considered**:
- 切換失敗即視為整個同步失敗，下次觸發從 Phase 1 重新抓取：實作更簡單（不需要判斷 staged 狀態直接重播），但對「Phase 1 成本遠高於 Phase 2」的真實情境（分頁抓取涉及大量網路 I/O）是不必要的浪費。

### Decision: 錯誤訊息一律消毒（只存錯誤類別與截斷訊息），禁止存完整 payload

**Choice**: `sync_runs.error_message` 只存「錯誤類別名稱: 訊息前 300 字」，不論來源是抓取失敗、切換失敗或其他例外；相關 log 輸出比照辦理，不印出完整 response body 或任何 payload。

**Rationale**: 錯誤訊息在維運端點與 CLI 都會被讀取甚至顯示在前端頁面上，若原樣存放外部服務回應的完整內容，可能夾帶不該外洩的資訊（即使本範例的 mock 來源不含敏感資料，這仍是示範給讀者的資安衛生習慣）；消毒後的錯誤訊息也更適合直接顯示在維運介面，不需要額外的顯示層過濾。

**Alternatives considered**:
- 存完整錯誤內容供除錯：除錯效益有限（截斷前 300 字通常已足夠定位問題類別），且與「維運端點/前端可直接顯示」的目標衝突。

### Decision: mock 範本庫服務採決定性生成（非 `Math.random`），並用 `overlap` 參數模擬分頁漂移

**Choice**: `routes/mock-source.ts` 的資料集完全由索引運算推導（`sourceListId = 1000+i`、`sourceItemId = sourceListId*100+j`、`priority = (j*7) % 10`、tag 從固定名稱池以索引算術選取），總量與模式皆可由查詢參數與 `PUT /mock-source/mode` 控制；`overlap=1` 時第 2 頁起把前一頁最後一列重複於頁首。

**Rationale**: 決定性生成讓測試可以對「第 N 頁應該長什麼樣子」做精確斷言，不需要額外的 fixture 或 snapshot；`overlap` 參數則是刻意重現「offset 分頁在資料隨時間變動的來源上會有微幅重疊或漂移」這個真實世界的現象，讓 staging upsert 的冪等性（跨頁重複鍵值不會造成錯誤或重複計數）有明確的測試場景可以驗證。

**Alternatives considered**:
- 用隨機資料生成：更貼近「看起來像真的」，但測試斷言必須改用範圍或屬性驗證（property-based），犧牲教學範例最重視的可預測性與可讀性。
- 真的串接一個外部服務：本範例沒有真實外部依賴的必要，且會讓測試依賴網路與外部服務可用性。

### Decision: CLI 的 `no_data` 結果視為非正常完成的結束碼

**Choice**: `staging-sync-run.ts` 執行一次同步後，若結果為 `no_data`（來源回傳空集合），CLI 以結束碼 `2` 退出（非 `0`），與失敗／鎖衝突的結束碼 `1` 及成功的結束碼 `0` 三方區分。

**Rationale**: 若排程或維運腳本把 `no_data` 視同「同步完成」（結束碼 0），一旦來源服務長期回傳空集合（例如來源端設定錯誤、連線指向錯的環境），這個異常狀況會被靜默吞掉、無法從排程的結束碼直接察覺。用獨立的結束碼強迫呼叫端明確處理「這次同步跑完了，但沒有任何資料」這個情境，不能與「跑完且有資料」混為一談。

**Alternatives considered**:
- `no_data` 與成功共用結束碼 0：實作更簡單，但抹除了「本次同步是否實際處理了資料」這個對維運告警很關鍵的訊號。

## Risks / Trade-offs

- [Risk] 切換交易（mark + merge + 衍生欄位重算，三張目標表全部在同一交易內）在資料量夠大時可能長時間持有列鎖，阻塞其他寫入者（讀取者因 MVCC 不受列鎖影響） → Mitigation：本範例鎖定教學規模（預設 120 筆清單），交易時長可控；正式環境若要套用此模式於更大資料量，需額外評估交易時長與鎖等待策略（例如分批切換多個 batch，但那會引入新的複雜度，不在本範例範圍）。
- [Risk] fencing 機制（owner_token/lease_version）增加狀態機的心智負擔，讀者需要理解「鎖」與「fencing」是兩個不同層次的保護才能看懂拒絕路徑 → Mitigation：`fence.ts` 集中定義 `SyncRunFence` 型別與傳遞規則，design.md 與程式註解需明確解釋兩者的分工（鎖=誰先開始，fencing=誰現在還算數）。
- [Risk] 讀者可能誤以為切換交易期間會讀到「整批被標記 `is_active=false`、尚未合併覆寫回 `true`」的中間態，進而誤判此設計會造成讀取端短暫資料消失 → Mitigation：PostgreSQL MVCC 保證未 commit 的變更對其他交易完全不可見，讀取者只會看到 commit 前或 commit 後兩種一致狀態；「mark 之後 merge 之前」的順序只在交易內部有意義，教學文件與程式註解需明確澄清這一點。
- [Risk] staging 表在切換失敗後會殘留，若忘記執行 `pruner` 會持續佔用磁碟空間 → Mitigation：`pruner.ts` 提供明確的保留期限策略（done 1 日／fetch_failed·abandoned 7 日／terminal run 90 日），並在維運文件中說明需要排程或人工定期執行；本 change 不內建自動排程（見 Non-Goals）。
- [Risk] mock 來源服務狀態存於 process 記憶體，重啟即重置、多個 server 實例間不共享 → Mitigation：教學範例僅單一 server 進程執行，未涉及水平擴充下的狀態一致性問題（比照 `mock-external.ts` 既有的取捨）。
- [Risk] advisory lock 綁定單一連線，連線斷線後鎖自動釋放但持有者的 worker 進程未必真的停止 → Mitigation：這正是 fencing 存在的理由；`claimForSwap`／`writePage` 等所有寫入都在動作前重新驗證 fence，擋下任何已失去鎖但仍嘗試寫入的舊執行者。

## Migration Plan

全新功能，資料表為新增（`sync_runs`、3 張 staging 表、3 張目標表），對既有 `users`／`todos`／`outbox_messages` 表無破壞性變更。

1. `packages/db/src/index.ts` 補上 pg `pool` 匯出（`mutex.ts` 依賴）。
2. `pnpm db:push`（開發庫）與 `pnpm db:push:test`（測試庫）建立全部新表與 partial unique index。
3. 補上 `.env` 的 `STAGING_SYNC_SOURCE_URL`／`STAGING_SYNC_PAGE_SIZE`／`STAGING_SYNC_FETCH_TIMEOUT_MS`（皆有預設值，可省略）。
4. `apps/server/src/test/helpers.ts` 的 `resetDb()` 加入新表 TRUNCATE。
5. Rollback：移除 `apps/server/src/staging-sync/*`、`routes/mock-source.ts`、`routes/staging-sync-admin.ts`、`scripts/staging-sync-*.ts`；`db:push` 移除新增的 schema 檔案後重新推送；因無其他表依賴這些新表，回滾風險低。

## Open Questions

- `pruner` 是否需要在本 change 範圍內就接上排程（例如比照 `transactional-outbox` worker 的模式）？目前決議為否（見 Non-Goals），僅提供 CLI；若未來要示範「常駐 worker 的排程正確性」，`add-transactional-outbox` 的 `sweep-loop.ts` 已是同一類問題的參考實作，可視需要另開 change 擴充。
- `manifest.ts` 是否要在本 change 內就示範第二個 `sync_type`（驗證其通用性）？目前決議為否，留給未來擴充；但實作時應確保 `manifest.ts` 沒有寫死 `template_catalog` 專屬邏輯，維持可擴充的形狀。
