<!--
This file is a mandatory schema output; it records the isolated work environment.
The apply phase reads it on every start to confirm work is happening in the
correct worktree.
-->

# Environment: add-todolist-mvp

## Branch

- **Branch name**: `change/add-todolist-mvp`
- **Base branch**: main

## Setup commands

```bash
git worktree add /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-todolist-mvp -b change/add-todolist-mvp main
cd /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-todolist-mvp
fnm use 22.22.2          # 依 .node-version；vitest 4 / rolldown 需 Node 20.12+/22+
pnpm install
pnpm test                # baseline
```

## Verification

- **Baseline tests**: PASS — `pnpm test` 於 Node 22.22.2 下通過（web + server 皆「No test files found」走 `--passWithNoTests`，exit 0）。
- **Initial commit hash**: `5749f71caabd63c2c6d06756a8147077b672ea63`
- **Worktree path** (absolute): `/Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-todolist-mvp`

## Teardown

```bash
cd /Users/danny/Desktop/project/fastify_drizzle_todolist
git worktree remove /Users/danny/Desktop/project/fastify_drizzle_todolist-worktrees/add-todolist-mvp
git branch -D change/add-todolist-mvp   # only if the branch is no longer needed
```
