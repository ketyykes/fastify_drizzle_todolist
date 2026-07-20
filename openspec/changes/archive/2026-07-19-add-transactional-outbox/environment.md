<!--
This file is a mandatory schema output; it records the isolated work environment.
The apply phase reads it on every start to confirm work is happening in the
correct worktree.

回溯記錄／誠實揭露：本 change 實際於既有分支 `change/add-transactional-outbox`
（在專案原本的工作目錄內）開發，**未使用獨立 git worktree**。以下內容依 schema
格式要求填寫，Worktree path 一律以本專案實際絕對路徑表示。
-->

# Environment: add-transactional-outbox

## Branch

- **Branch name**: `change/add-transactional-outbox`
- **Base branch**: main

## Setup commands

```bash
# 本 change 未建立獨立 worktree；若依 schema 慣例重建隔離環境，指令如下：
git worktree add /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-transactional-outbox \
  -b change/add-transactional-outbox main
cd /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-transactional-outbox
fnm use 22.22.2          # 依 .node-version
pnpm install
pnpm test                # baseline
```

實際開發歷程改為直接在既有工作目錄的分支上進行：

```bash
cd /Users/danny/Desktop/project/fastify_drizzle_todolist
git checkout -b change/add-transactional-outbox main
fnm use 22.22.2
pnpm install
pnpm test                # baseline（沿用 add-todolist-mvp 建立的 mysql/postgres 測試基礎設施）
```

## Verification

- **Baseline tests**: PASS —— 依任務交付前提（本 change 為「已實作完成並全綠」的教學
  範例回溯記錄），server 與 web 兩側測試套件（含本 change 新增的 `outbox/*.test.ts`、
  `routes/mock-external.test.ts`、`routes/outbox-admin.test.ts`、
  `scripts/outbox-*.test.ts`、`hooks/use-outbox-stats.test.tsx`）皆全套通過。本次
  補寫 openspec 文件的過程未重新執行測試套件以取得逐項數字，故不在此臆造測試筆數。
- **Initial commit hash**: `14253fb987b6be3d98785e7baa3a39773c3deb7b`（`main` 與
  `change/add-transactional-outbox` 的共同祖先／分支基準點）
- **Worktree path** (absolute): `/Users/danny/Desktop/project/fastify_drizzle_todolist`
  （即本專案根目錄；本 change 未使用獨立 worktree，此路徑僅為既有工作目錄）

## Teardown

```bash
# 因本 change 未建立獨立 worktree，無需 git worktree remove。
# 若要清理分支（已合併至 main 之後）：
cd /Users/danny/Desktop/project/fastify_drizzle_todolist
git branch -d change/add-transactional-outbox   # only if the branch is no longer needed
```
