# Tasks: add-seed-dev-account

<!--
  Apply 依 `- [ ]` checkbox 追蹤進度。
  §0 為前置設定（非 TDD，後續 RED 依賴其存在）；§1 為核心邏輯，每個 GREEN 前必有
  對應 RED，測試名稱對齊 test-plan.md；§2 為進入點與指令串接（glue code，非 TDD，
  無業務邏輯可測）；§3 為人工驗證（非 TDD）。
-->

## 0. 前置設定（非 TDD，後續 RED 依賴）

- [ ] 0.1 `packages/env/src/server.ts` 新增 `SEED_USER_EMAIL`
      （`z.email().default("dev@example.com")`）與 `SEED_USER_PASSWORD`
      （`z.string().min(8).default("dev12345")`）
- [ ] 0.2 根目錄 `.env.example` 與 `apps/server/.env.example` 補上這兩個選填變數的
      說明，含「僅供本機測試，正式環境務必覆寫或移除」註記

## 1. seed-dev-user 核心邏輯（dev-seed-account）
Depends on: §0

- [ ] 1.1 RED: 寫測試 `seed_creates_user_when_absent`
- [ ] 1.2 GREEN: 實作 `apps/server/src/scripts/seed-dev-user.ts` 的
      `seedDevUser(overrides?)`：查詢 email 是否存在，不存在則以
      `const BCRYPT_ROUNDS = 10` bcrypt hash 密碼並 insert
- [ ] 1.3 RED: 寫測試 `seed_skips_when_already_exists`
- [ ] 1.4 GREEN: 補上「email 已存在則直接 return，不 insert、不更新密碼」分支
- [ ] 1.5 RED: 寫測試 `seed_uses_provided_overrides`
- [ ] 1.6 GREEN: 支援 `overrides.email` / `overrides.password` 參數覆寫
- [ ] 1.7 RED: 寫測試 `seed_uses_default_when_no_overrides`
- [ ] 1.8 GREEN: 未帶 overrides 時 fallback 到 `env.SEED_USER_EMAIL` /
      `env.SEED_USER_PASSWORD`
- [ ] 1.9 RED: 寫測試 `seeded_account_can_login_via_auth_login`
- [ ] 1.10 GREEN: 端到端驗證 `seedDevUser()` 產生的密碼雜湊與既有
      `POST /auth/login` 的 `bcrypt.compare` 相容（預期本來就相容，此步驟以測試
      通過為準，不預期需要額外實作變更）

## 2. main() 進入點與指令串接（glue code，非 TDD）
Depends on: §1

- [ ] 2.1 在 `seed-dev-user.ts` 加上 `main()` + `isMainModule` guard（比照
      `outbox-prune.ts`），console.log 結果（建立成功 / 略過已存在）
- [ ] 2.2 `apps/server/package.json` 新增 `"seed": "tsx src/scripts/seed-dev-user.ts"`
- [ ] 2.3 根目錄 `package.json` 新增 `"db:seed": "pnpm --filter server seed"`
- [ ] 2.4 `docker-compose.yml` 的 `server` service：`command` 串接 `pnpm db:seed`
      （`pnpm db:push` 之後、`pnpm --filter server dev` 之前）；`environment` 加上
      `SEED_USER_EMAIL: ${SEED_USER_EMAIL:-}` 與
      `SEED_USER_PASSWORD: ${SEED_USER_PASSWORD:-}`
- [ ] 2.5 `CLAUDE.md` 的「相關指令」段落補上 `pnpm db:seed` 說明

## 3. 驗證（人工，非 TDD）
Depends on: §2

- [ ] 3.1 本機執行 `pnpm db:seed` 兩次，確認第二次不報錯、不新增重複列
- [ ] 3.2 `docker compose down -v && docker compose up` 驗證全新環境自動 seed
      成功，並能用預設帳密透過 `/auth/login` 登入
- [ ] 3.3 `pnpm test` 全套通過（含新測試），確認未影響既有測試（尤其測試庫
      `resetDb()` 相關流程）
