<!--
This file is a mandatory schema output; the apply phase reads it to dispatch
subagents and assign models.

回溯記錄：本 change 的實作階段實際已由 Sonnet 平行派工的 subagent 完成
（非本文件事後才規劃的執行方式），審查階段由 Fable 執行。以下內容依 schema
格式要求記錄「若照本流程走」的規劃版本，供軌跡完整與未來同類 change 參考。
-->

# Execution Plan: add-transactional-outbox

## Mode

subagent-driven

## Per-task contract

每個被派工的 subagent 不繼承主對話上下文，只會收到以下內容：

- tasks.md 中該任務的完整文字（含 RED + GREEN 配對）
- test-plan.md 中對應的列（test name / scenario / assertion / why first / tier）
- 相關 spec.md 段落（`transactional-outbox` capability 的該 requirement + scenarios）
- 相關 design.md 段落（影響此任務的決策 / 風險），例如：
  - outbox 只存 `ref_id`、送出前重抓最新資料
  - fast-path + sweeper 雙軌並行、`FOR UPDATE SKIP LOCKED` 認領
  - 退避查表（非公式）、死信永不自動重試
  - 卡住回收門檻 15 分鐘、`sweep-loop.ts` 的 in-flight 防重疊設計
- **Worktree path**（來自 environment.md）：`/Users/danny/Desktop/project/fastify_drizzle_todolist`
  （本 change 實際於既有分支 `change/add-transactional-outbox` 開發，未使用獨立
  worktree；所有檔案操作與測試皆在此路徑、Node 22 下進行）
- **Not given**：其他任務的內容、不相關 capability（`user-auth`／`todo-management`
  既有行為）的 spec、主對話的探索脈絡

## Roles

<!-- 模型名稱為 Claude 分級範例；無此分級的環境請對應到最接近的 fast / balanced / strongest。 -->

### Implementer

- **default_model**: `sonnet`
  - **註**：schema 的建議起點是 `haiku`；本 change 為回溯記錄，實作實際由 Sonnet
    平行派工完成，故此處起點即記為 `sonnet`（反映真實執行，而非 schema 預設）。
- **upgrade_to_sonnet_when**: （已是 default，不適用）
- **upgrade_to_opus_when**:
  - 被 BLOCKED 後重新派工
  - 需架構層級判斷（例如 `FOR UPDATE SKIP LOCKED` 的交易邊界、`sweep-loop.ts`
    的 in-flight 防重疊設計、fast-path 與 sweeper 的錯誤處理分工）
  - 任務同時動到 3 個以上模組（例如同時改 schema + repository + route + worker）

### Spec Reviewer (Stage 1)

- **default_model**: `sonnet`
- **rationale**: 比對 spec 與程式需要中等判斷力，尤其本 capability 狀態機分支多
  （pending/processing/done/dead），容易漏掉某個轉移路徑沒測到
- **Review checklist**:
  - [ ] 每條 spec requirement 都有對應實作？
  - [ ] 實作有沒有做 spec 沒要求的事（over-engineering，例如自動重試死信、加 jitter）？
  - [ ] RED 測試對應到正確的 Scenario？
  - [ ] GREEN 實作只滿足該 RED、未動到不相關 requirement（例如做 sweeper 時誤改
        `todo-management` 既有的 CRUD 行為）？
  - [ ] outbox 是否確實只存 `refId`、送出前有重抓最新資料（而非回放舊 payload）？
- **Never reviews**: 命名 / 結構 / 品質（Stage 2 範疇）

### Code-Quality Reviewer (Stage 2)

- **default_model**: `opus`
- **rationale**: 抓併發 / 狀態機邊界 / 交易邊界最需最強模型，本 capability 對
  「送出動作不可在任何交易 / row lock 之內」的要求特別敏感
- **Review checklist**:
  - [ ] 命名清楚且與既有風格一致（camelCase 變數、PascalCase 型別、繁中註解）？
  - [ ] 有無重複（DRY）——例如 fast-path 與 sweeper 是否重用同一組
        `markDone`/`markFailed`？
  - [ ] 交易邊界正確：HTTP 送出是否確實在交易外執行？
  - [ ] 邊界處理（空批次、ref 已刪、退避查表邊界、卡住回收邊界、CLI 參數）？
  - [ ] 錯誤處理合理（單筆失敗不中斷整批、fast-path 失敗不影響 API 回應）？
  - [ ] Magic number / string 是否抽出（`BATCH_LIMIT`、`STALE_PROCESSING_MINUTES`、
        狀態字面量集中於 `OUTBOX_STATUS`）？
  - [ ] 可讀性？
- **Never reviews**: spec 對不對（Stage 1 已負責）

## Escalation

- Implementer 被同一 reviewer 連續退回 3 次 → 升級模型並重新派工
- Spec Reviewer 自身判斷前後不一致 → 升級回主對話，由人釐清 spec
- Code-Quality Reviewer 與 Implementer 的風格分歧 → 以既有 codebase 風格為準
- 任一階段 BLOCKED 超過 30 分鐘 → 升級給人處理
