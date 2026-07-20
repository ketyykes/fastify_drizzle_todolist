<!--
This file is a mandatory schema output; it records the isolated work environment.
The apply phase reads it on every start to confirm work is happening in the
correct worktree.

本 change 於 proposal 階段撰寫，尚未建立獨立 worktree，也尚未執行過任何測試。
Verification 區塊的欄位為據實填寫（HEAD hash 為當下 `git rev-parse HEAD` 的真實
輸出），Baseline tests 尚未執行，將於 apply Step 0 實際跑過後回填。
-->

# Environment: add-seed-dev-account

## Branch

- **Branch name**: `change/add-seed-dev-account`
- **Base branch**: main

## Setup commands

```bash
git worktree add /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-seed-dev-account \
  -b change/add-seed-dev-account main
cd /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-seed-dev-account
fnm use 22.22.2          # 依 .node-version
pnpm install
pnpm test                # baseline
```

## Verification

- **Baseline tests**: 尚未執行 —— 本檔於 proposal 階段撰寫，尚未建立 worktree，
  將於 apply Step 0 建立 worktree並實際執行 `pnpm test` 後，把 PASS/FAIL 結果回填
  於此
- **Initial commit hash**: `3d1b48a804065d69d1bdbe50a6081fea22681ffd`（proposal
  撰寫當下 `main` 分支的 HEAD，經 `git rev-parse HEAD` 取得；worktree 建立時的
  實際基準 commit 以此為準，若 `main` 之後有新 commit 則以 apply 當下重新確認）
- **Worktree path** (absolute):
  `/Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-seed-dev-account`
  （尚未建立，apply Step 0 會依上方 Setup commands 建立）

## Teardown

```bash
cd /Users/danny/Desktop/project/fastify_drizzle_todolist
git worktree remove /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-seed-dev-account
git branch -d change/add-seed-dev-account   # only if the branch is no longer needed
```
