# Overview: add-seed-dev-account

## Scope

新增一支 idempotent 的 seed 腳本，讓 `docker compose up` 之後自動存在一組固定測試
帳密，不需要任何手動註冊步驟就能登入。帳密內容可由 `.env` 覆寫，未設定時使用內建
預設值。

**Size**: small — 只影響 1 個 capability（`dev-seed-account`），沒有新依賴、沒有
架構變動，預估任務量在個位數的任務群組內。
**Frontend involved**: no — 純後端腳本、環境變數設定與 `docker-compose.yml`，沒有
任何 UI 改動。

---

## What Changes

- 新增 `seed-dev-user.ts`：email 不存在才建立帳號，已存在則略過（不更新密碼）。
- `packages/env` 新增 `SEED_USER_EMAIL` / `SEED_USER_PASSWORD` 兩個有預設值的選填
  變數。
- `docker-compose.yml` 的 `server` service 啟動鏈接上 `pnpm db:seed`，並把這兩個
  變數接進 `environment:` 讓 `.env` 可覆寫。
- 新增 `db:seed` 指令別名（比照 `db:push`）、補齊 `.env.example` 與 `CLAUDE.md` 文件。

Before / after 對照：

```
=== Before ===
docker compose up
  └─ db:push（建表）
  └─ tsx watch（啟動 server）

users 表：空的，需手動 POST /auth/register 才有帳號可登入


=== After ===
docker compose up
  └─ db:push（建表）
  └─ db:seed（新增：email 不存在才建立固定帳號，已存在則略過）
  └─ tsx watch（啟動 server）

users 表：至少有一筆可登入的固定測試帳號
         （SEED_USER_EMAIL / SEED_USER_PASSWORD，可由 .env 覆寫，未設定則用預設值）
```
