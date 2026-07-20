# Proposal: add-seed-dev-account

## Why

新電腦第一次跑起這個專案時，資料庫是全新的，沒有任何帳號可以登入，得先手動呼叫
`/auth/register` 才能開始測試。`add-todolist-mvp` 的 design.md 當時就留了一條 Open
Question：「是否需要一組預設 seed 帳號方便測試？」，彼時決定先不做；現在確認實際
需要——想要一組固定、可預期的測試帳密，讓 `docker compose up` 之後不需要任何手動
步驟就能登入。

## What Changes

- 新增 `apps/server/src/scripts/seed-dev-user.ts`：查詢固定 email 是否已存在，不存在
  才建立帳號（bcrypt 雜湊密碼）；已存在則略過（idempotent，可重複執行）。
- `packages/env/src/server.ts` 新增 `SEED_USER_EMAIL` / `SEED_USER_PASSWORD`（zod
  schema，皆有預設值，未設定對應環境變數時自動套用預設帳密）。
- `docker-compose.yml` 的 `server` service 啟動指令鏈接上 `pnpm db:seed`（於
  `db:push` 之後、`pnpm --filter server dev` 之前），並把這兩個環境變數接進
  `environment:` 區塊，讓根目錄 `.env` 可以覆寫。
- `apps/server/package.json` 新增 `seed` 指令；根目錄 `package.json` 新增 `db:seed`
  別名（比照既有 `db:push` 的慣例）。
- 根目錄與 `apps/server` 的 `.env.example` 補上這兩個選填變數的說明。
- `CLAUDE.md` 補一條指令說明。

## Capabilities

### New Capabilities

- `dev-seed-account`: 開發環境啟動時自動確保存在一組固定測試帳密，可用於
  `/auth/login`；帳密由環境變數控制，未設定時使用內建預設值；重複執行具備冪等性。

### Modified Capabilities

<!-- 無：不改動 user-auth 既有的註冊/登入行為，只是多一筆由腳本建立的資料 -->

## Impact

- **後端 `apps/server`**：新增 `src/scripts/seed-dev-user.ts` 與對應測試；
  `package.json` 新增 `seed` 指令。
- **環境設定 `packages/env`**：`server.ts` 新增兩個有預設值的選填變數。
- **Docker / 設定**：`docker-compose.yml` 的 `server` service（`command` 與
  `environment` 皆改）；根目錄 `package.json` 新增別名；兩份 `.env.example` 文件化。
- **文件**：`CLAUDE.md` 補指令說明。
- **不影響**：`user-auth` 既有的 API 行為與 `users` 表結構、測試資料庫（`_test`，
  依討論結論不 seed）、前端。
