# Environment: add-staging-sync

## Branch

- **Branch name**: `change/add-staging-sync`
- **Base branch**: develop

## Setup commands

```bash
# 標準做法（依 schema 慣例建立獨立 worktree）：
git worktree add /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-staging-sync \
  -b change/add-staging-sync develop
cd /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-staging-sync
fnm use 22.22.2          # 依 .node-version
pnpm install
pnpm test                # baseline
```

實際做法比照本專案既有慣例（`add-transactional-outbox`、`add-seed-dev-account` 皆同）：直接在既有工作目錄的分支上開發，未使用獨立 git worktree。

```bash
cd /Users/danny/Desktop/project/fastify_drizzle_todolist
git checkout -b change/add-staging-sync develop   # 若分支已存在則直接 checkout
fnm use 22.22.2
pnpm install
pnpm test                # baseline（沿用既有 postgres/docker 測試基礎設施）
```

## Verification

- **Baseline tests**: PASS —— 分支基準點（尚未動工前）的真實基準為 `apps/server` 13 個測試檔、96 個測試全綠（含一筆基準修復 commit：todos 測試檔統一覆寫 outbox webhook）。撰寫本文件當下實測 `apps/server` 142 個測試、`apps/web` 7 個測試全綠，其中 142 已包含並行動工完成的 Wave B1 schema（18 測試）與 mock-source 路由（28 測試）。
- **Initial commit hash**: `7ee644593ff2007e936b3ce463437f853e787e07`（`develop` 與 `change/add-staging-sync` 的共同祖先／分支基準點，以 `git merge-base develop change/add-staging-sync` 取得）。
- **Worktree path** (absolute): `/Users/danny/Desktop/project/fastify_drizzle_todolist`
  （本 change 未使用獨立 worktree，此路徑為既有工作目錄；分支 `change/add-staging-sync` 已存在並已 checkout。apply 階段的 Step 0 應確認 cwd 落在此路徑，並在開始任何任務前重新執行一次 `pnpm test` 確認 baseline 仍為綠燈，因為分支基準點之後可能已有其他任務或並行工作線產生新的 commit。）

## Teardown

```bash
# 因本 change 未建立獨立 worktree，無需 git worktree remove。
# 若要清理分支（已合併至 develop 之後）：
cd /Users/danny/Desktop/project/fastify_drizzle_todolist
git branch -d change/add-staging-sync   # only if the branch is no longer needed
```
