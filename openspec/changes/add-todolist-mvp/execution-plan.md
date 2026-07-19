<!--
This file is a mandatory schema output; the apply phase reads it to dispatch
subagents and assign models.
-->

# Execution Plan: add-todolist-mvp

## Mode

subagent-driven

## Per-task contract

每個被派工的 subagent 不繼承主對話上下文，只會收到以下內容：

- tasks.md 中該任務的完整文字（含 RED + GREEN 配對）
- test-plan.md 中對應的列（test name / scenario / assertion / why first / tier）
- 相關 spec.md 段落（該 capability 的 requirement + scenarios）——`user-auth` 或 `todo-management` 擇一
- 相關 design.md 段落（影響此任務的決策 / 風險），例如：
  - Token 用 Bearer + localStorage、JWT 用 `@fastify/jwt`、密碼用 `bcryptjs`
  - 跨使用者存取回 404、todos 一律以 `user_id` 過濾
- **Worktree path**（來自 environment.md）：`/Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-todolist-mvp`，所有檔案操作與測試皆須在此 worktree 內、Node 22.22.2 下進行
- **Not given**：其他任務的內容、不相關 capability 的 spec、主對話的探索脈絡

## Roles

<!-- 模型名稱為 Claude 分級範例；無此分級的環境請對應到最接近的 fast / balanced / strongest。 -->

### Implementer

- **default_model**: `haiku`
- **upgrade_to_sonnet_when**:
  - 任務動到 3 個以上檔案（例如同時改 schema + route + 前端）
  - 需比對既有程式風格（沿用 `http-client.ts`、shadcn 元件、Drizzle schema 慣例）
  - 需除錯既有失敗測試
- **upgrade_to_opus_when**:
  - 被 BLOCKED 後重新派工
  - 需架構層級判斷（例如 dev 容器啟動流程、CORS/JWT plugin 註冊順序）

### Spec Reviewer (Stage 1)

- **default_model**: `sonnet`
- **rationale**: 比對 spec 與程式需要中等判斷力；Haiku 易漏 spec 偏差
- **Review checklist**:
  - [ ] 每條 spec requirement 都有對應實作？
  - [ ] 實作有沒有做 spec 沒要求的事（over-engineering，例如額外加 refresh token）？
  - [ ] RED 測試對應到正確的 Scenario？
  - [ ] GREEN 實作只滿足該 RED、未動到不相關 requirement（例如做 todos 時誤改 auth）？
- **Never reviews**: 命名 / 結構 / 品質（Stage 2 範疇）

### Code-Quality Reviewer (Stage 2)

- **default_model**: `opus`
- **rationale**: 抓慣用法 / 設計 / 邊界最需最強模型
- **Review checklist**:
  - [ ] 命名清楚且與既有風格一致（camelCase 變數、PascalCase 型別、繁中註解）？
  - [ ] 有無重複（DRY）——例如 authenticate preHandler、錯誤回應是否共用？
  - [ ] 邊界處理（空 title、重複 email、無效 token、跨使用者 id）？
  - [ ] 錯誤處理合理（不洩漏帳號存在性、統一錯誤格式）？
  - [ ] Magic number / string 是否抽出（JWT 有效期、狀態碼）？
  - [ ] 可讀性？
- **Never reviews**: spec 對不對（Stage 1 已負責）

## Escalation

- Implementer 被同一 reviewer 連續退回 3 次 → 升級模型並重新派工
- Spec Reviewer 自身判斷前後不一致 → 升級回主對話，由人釐清 spec
- Code-Quality Reviewer 與 Implementer 的風格分歧 → 以既有 codebase 風格為準
- 任一階段 BLOCKED 超過 30 分鐘 → 升級給人處理
