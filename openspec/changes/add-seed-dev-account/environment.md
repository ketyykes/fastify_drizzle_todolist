<!--
This file is a mandatory schema output; it records the isolated work environment.
The apply phase reads it on every start to confirm work is happening in the
correct worktree.

回溯記錄／誠實揭露：apply 階段實際未建立獨立 git worktree。原因：本 repo 的
docker-compose.yml 以 bind-mount（`.:/app`）掛載「主要工作目錄」給 server/worker
容器，若改在另一個 worktree 目錄下工作，§3 的 `docker compose down -v && up`
驗證步驟就連不到這次的程式碼變更（容器看到的仍是舊檔案）。因此比照
`add-transactional-outbox` 的先例，直接在主要工作目錄開 `change/add-seed-dev-account`
分支進行，未建立獨立 worktree。以下內容依 schema 格式要求填寫，Worktree path 一律
以本專案實際絕對路徑表示；Baseline tests 為 apply Step 0 實際執行 `pnpm test` 的
真實輸出（非臆測）。
-->

# Environment: add-seed-dev-account

## Branch

- **Branch name**: `change/add-seed-dev-account`
- **Base branch**: main

## Setup commands

```bash
# 本 change 未建立獨立 worktree；若依 schema 慣例重建隔離環境，指令如下：
git worktree add /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-seed-dev-account \
  -b change/add-seed-dev-account main
cd /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-seed-dev-account
pnpm install
pnpm test                # baseline
```

實際開發歷程改為直接在既有工作目錄的分支上進行：

```bash
cd /Users/danny/Desktop/project/fastify_drizzle_todolist
git checkout -b change/add-seed-dev-account main
pnpm test                # baseline（沿用既有相依安裝，未重新 pnpm install）
```

## Verification

- **Baseline tests**: PASS —— `pnpm test`（`pnpm --filter web test && pnpm --filter
  server test`）於本分支 HEAD（含本 change 的 openspec 文件 commit，尚未加入任何
  程式碼變更）實際執行結果：web 2 test files / 7 tests 全數通過，server 12 test
  files / 91 tests 全數通過。
- **Initial commit hash**: `b88bca043d09adc59c0a0c14414dc21645ad7b1e`（`git
  rev-parse HEAD` 的真實輸出；為 `docs: 新增 add-seed-dev-account openspec change
  提案` 這個 commit，即本分支自 `main`（`3d1b48a8`）分岔後的第一個 commit，也是
  baseline 測試實際執行時的 HEAD）
- **Worktree path** (absolute): `/Users/danny/Desktop/project/fastify_drizzle_todolist`
  （即本專案根目錄；本 change 未使用獨立 worktree，此路徑僅為既有工作目錄）

## Teardown

```bash
# 因本 change 未建立獨立 worktree，無需 git worktree remove。
# 若要清理分支（已合併至 main 之後）：
cd /Users/danny/Desktop/project/fastify_drizzle_todolist
git checkout main
git branch -d change/add-seed-dev-account   # only if the branch is no longer needed
```
