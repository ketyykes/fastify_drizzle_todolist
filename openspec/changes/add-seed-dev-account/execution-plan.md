<!--
This file is a mandatory schema output; the apply phase reads it to dispatch
subagents and assign models.
-->

# Execution Plan: add-seed-dev-account

## Mode

subagent-driven

## Per-task contract

Context every dispatched subagent receives (subagents do not inherit the
main conversation):
- The full text of the task from tasks.md (including the RED + GREEN pair)
- The matching entry in test-plan.md (test name / scenario / assertion / why first / tier)
- The relevant spec.md section (the capability's requirement + scenarios)
- The relevant design.md section (decisions / risks affecting this task)
- The worktree path from environment.md（本 change 使用獨立 worktree；所有派發的
  subagent 都在同一個 worktree 內工作，不另外建立）
- Not given: other tasks; unrelated capability specs

## Roles

<!-- Model names are Claude tiers used as examples; on hosts without them,
     map to the closest fast / balanced / strongest equivalents. -->

### Implementer

- **default_model**: `haiku`
- **upgrade_to_sonnet_when**:
  - Task touches 3+ files（例如 §2 的 docker-compose / package.json / CLAUDE.md
    多檔案同動的 glue task）
  - Pattern matching against existing code is needed（例如比照 `outbox-prune.ts`
    的 `main()` + `isMainModule` guard 寫法）
  - Debugging an existing failing test
- **upgrade_to_opus_when**:
  - Redispatched after BLOCKED
  - Architecture-level judgment required（本 change 範圍小，預期不會觸發）

### Spec Reviewer (Stage 1)

- **default_model**: `sonnet`
- **rationale**: comparing spec to code requires moderate judgment;
  Haiku tends to miss spec deviations
- **Review checklist**:
  - [ ] Every spec requirement has matching implementation?
  - [ ] Did the implementation do anything the spec did not ask for
        （例如誤加 upsert 更新密碼的邏輯——design.md 明確排除）?
  - [ ] Does the RED test correspond to the correct Scenario?
  - [ ] Does the GREEN implementation only satisfy the RED, without touching
        unrelated requirements?
- **Never reviews**: naming / structure / quality (Stage 2 territory)

### Code-Quality Reviewer (Stage 2)

- **default_model**: `opus`
- **rationale**: catching idioms / design / edge cases benefits most from
  the strongest model
- **Review checklist**:
  - [ ] Naming is clear and consistent with existing style
        （比照 `outbox-prune.ts` / `outbox-requeue-dead.ts` 的命名慣例）?
  - [ ] Any duplication (DRY)（`BCRYPT_ROUNDS` 常數依 design.md 決議刻意重複，
        不應被要求抽出共用模組）?
  - [ ] Edge cases handled?
  - [ ] Error handling is reasonable（依 design.md 決議不需額外 try/catch）?
  - [ ] Magic numbers / strings extracted?
  - [ ] Readability?
- **Never reviews**: whether the spec is right (Stage 1 already covered that)

## Escalation

- Implementer rejected by the same reviewer N times in a row (suggested N=3)
  → upgrade model and redispatch
- Spec Reviewer's own judgment is inconsistent → escalate to main conversation
  for spec clarification by a human
- Code-Quality Reviewer vs. Implementer style disagreements → existing codebase style wins
- Any stage BLOCKED for over 30 minutes → escalate to a human
