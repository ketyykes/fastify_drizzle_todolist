# Execution Plan: add-staging-sync

## Mode

subagent-driven

## Waves

本 change 模組數量多（後端 14 個 `staging-sync/` 核心模組＋mock 來源路由＋維運路由＋4 支 CLI＋前端頁面），依「基礎先行、可平行者平行、收斂驗證在最後」原則分成以下 waves。tasks.md 的分組（`## N.`）與此對齊，`Depends on:` 標註跨組依賴；同一 wave 內若標註「可平行」，代表兩個子群組彼此不互相依賴，可各自派工同時進行，但**同一子群組內部仍是單一 Implementer 依序完成，不得平行派工**（見下方 Forbidden）。

```
B1  Schema 與基礎建設
    packages/db/src/schema/{template-catalog,staging-sync}.ts、schema/index.ts、
    packages/db/src/index.ts（pool 匯出）、packages/env/src/server.ts（3 個 env）、
    apps/server/src/test/helpers.ts（resetDb 加新表）
    │
    ▼
B2  核心層（狀態機與鎖）              B2' Mock 來源與抓取／轉換（與 B2 可平行）
    constants / errors / config /         routes/mock-source.ts
    fence / manifest                      page-fetcher.ts
    mutex.ts（advisory lock）             page-transformer.ts
    run-manager.ts（狀態機＋fencing）
    │                                      │
    └──────────────┬───────────────────────┘
                   ▼
B3  寫入與協調層（依賴 B2 與 B2' 兩者）
    staging-writer.ts / merger.ts / orchestrator.ts / dispatcher.ts / pruner.ts
                   │
                   ▼
B4  維運介面
    routes/staging-sync-admin.ts、scripts/staging-sync-{run,status,abandon,prune}.ts、
    app.ts 註冊、package.json scripts
                   │
        ┌──────────┼──────────┐
        ▼                     ▼
C  專案文件                D  前端教學頁（依賴 B4）
   docs/staging-sync/           lib/staging-sync-api.ts
   design.md（比照既有            hooks/use-staging-sync.ts
   docs/outbox/design.md         routes/staging-sync-guide.tsx
   的完整規格文件）                router.tsx / header.tsx 接線
        └──────────┬──────────┘
                   ▼
E  收斂驗證與審查
   跨任務整合審查＋手動端到端驗證
```

## Per-task contract

每個被派工的 subagent 不繼承主對話上下文，只會收到以下內容：

- tasks.md 中該任務的完整文字（含 RED + GREEN 配對）
- test-plan.md 中對應的列（test name / scenario / assertion / why first / tier）
- 相關 spec.md 段落（`staging-sync` capability 的該 requirement + scenarios）
- 相關 design.md 段落（影響此任務的決策 / 風險），例如：
  - 逐頁抓取 + staging 暫存表 + 單一交易原子切換，取代全量載入記憶體或天真分批 commit
  - `sync_runs` 狀態機 + owner_token/lease_version fencing，不只靠 advisory lock
  - PostgreSQL session advisory lock 綁專用 client，release 必須用同一 client
  - partial unique index 作為持久 invariant
  - 合併以來源業務鍵、非本地自增主鍵為 conflict target
  - mark-and-sweep 語意；衍生欄位集合式重算的決定性 tie-breaker
  - 切換失敗回滾後直接重播 staged 資料，不重新抓取
  - 錯誤訊息消毒（只存類別＋截斷訊息）
- **Worktree path**（來自 environment.md）：`/Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-staging-sync`
- **Not given**：其他任務的內容、不相關 capability（`user-auth`／`todo-management`／`transactional-outbox` 既有行為）的 spec、主對話的探索脈絡

## Roles

<!-- 模型名稱為 Claude 分級範例；無此分級的環境請對應到最接近的 fast / balanced / strongest。 -->

### Implementer

- **default_model**: `sonnet`
  - **理由**：schema 建議的起點是 `haiku`，但本 change 幾乎每個任務都涉及交易邊界、fencing、鎖生命週期等併發正確性判斷（B2、B2' 之後的所有 wave），起點用 `haiku` 會在多數任務上立即觸發升級，來回成本高於直接以 `sonnet` 起跑。前端接線（wave D 部分任務）與純 CLI 參數解析等低風險任務，Implementer 可自行判斷降階以節省成本，但預設仍為 `sonnet`。
- **upgrade_to_sonnet_when**: （已是 default，不適用）
- **upgrade_to_opus_when**:
  - 被同一 reviewer 連續退回後重新派工
  - 需要架構層級判斷（例如切換交易的邊界劃分、fencing 憑證在各狀態轉移方法間的傳遞規則、mark-and-sweep 與衍生欄位重算的交易內排序、`page-fetcher.ts` 的重試與終止條件邊界）
  - 任務同時動到 3 個以上模組（例如 `merger.ts` 的 failureInjector 任務同時涉及交易、run-manager 狀態轉移與 manifest 驅動的合併邏輯）

### Spec Reviewer (Stage 1)

- **default_model**: `sonnet`
- **rationale**: 本 capability 狀態機分支多（`fetching`/`staged`/`swapping`/`done`/`fetch_failed`/`abandoned`）、fencing 規則貫穿多個模組，比對 spec 與程式需要中等以上判斷力才不會漏掉某個轉移路徑或 fencing 檢查點沒測到
- **Review checklist**:
  - [ ] 每條 spec requirement 都有對應實作？
  - [ ] 實作有沒有做 spec 沒要求的事（over-engineering，例如自行加上排程/常駐 worker、多 sync_type 支援）？
  - [ ] RED 測試對應到正確的 Scenario？
  - [ ] GREEN 實作只滿足該 RED、未動到不相關 requirement（例如寫 merger 時誤改 run-manager 既有的狀態轉移規則）？
  - [ ] 合併／關聯是否確實使用來源業務鍵而非本地主鍵？
  - [ ] 每個狀態轉移是否確實驗證 fencing 憑證（`WHERE id AND phase AND ownerToken AND leaseVersion`）？
- **Never reviews**: 命名 / 結構 / 品質（Stage 2 範疇）

### Code-Quality Reviewer (Stage 2)

- **default_model**: `opus`
- **rationale**: 抓交易邊界 / 併發 / 狀態機邊界最需最強模型；本 capability 對「advisory lock 與 fencing 的分工」「切換交易是否真的原子」「單頁短交易與整體切換交易的邊界是否正確」特別敏感，任何邊界錯置都會讓整個教學範例的核心論點失真
- **Review checklist**:
  - [ ] 命名清楚且與既有風格一致（camelCase 變數、PascalCase 型別、繁中註解、比照 `apps/server/src/outbox/` 的檔案風格）？
  - [ ] 有無重複（DRY）——例如 CLI 的參數解析、admin 路由與 CLI 是否重用同一組 repository 函式？
  - [ ] 交易邊界正確：每頁寫入是否真的是獨立短交易？切換是否真的在單一交易內完成（mark+merge+position+complete）？
  - [ ] fencing 憑證是否在每一次狀態轉移都被驗證，且驗證邏輯一致（不同方法各自實作出不一致的比對條件）？
  - [ ] 邊界處理（空頁、剛好整頁、fence 失效、terminal run 共存、singleton position、no_data 契約）？
  - [ ] 錯誤處理合理（單頁失敗是否正確中止整體抓取、單筆合併失敗是否正確回滾整筆切換交易）？
  - [ ] Magic number / string 是否抽出（`STAGING_CHUNK_SIZE`、retention 天數、phase 字面量集中於 `sync_run_phase` 與 `constants.ts`）？
  - [ ] 錯誤訊息是否確實消毒（不存完整 payload/token）？
  - [ ] 可讀性？
- **Never reviews**: spec 對不對（Stage 1 已負責）

## Escalation

- Implementer 被同一 reviewer 連續退回 3 次 → 升級模型並重新派工
- Spec Reviewer 自身判斷前後不一致 → 升級回主對話，由人釐清 spec
- Code-Quality Reviewer 與 Implementer 的風格分歧 → 以既有 codebase 風格（比照 `apps/server/src/outbox/` 既有模組）為準
- 任一階段 BLOCKED 超過 30 分鐘 → 升級給人處理
- wave 邊界誤判（例如 B3 任務誤以為可以在 B2' 完成前開工）→ 不得搶跑，退回等待該 wave 的前置任務全部通過 Stage 2 後再派工
