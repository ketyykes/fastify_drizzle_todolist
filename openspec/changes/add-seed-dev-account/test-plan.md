# Test Plan: add-seed-dev-account

<!--
  RED-phase 委諾文件。不描述實作邏輯，只描述「要測什麼、預期結果、為何優先」。
  所有測試皆為 integration tier：需要真的打測試用 Postgres（沿用
  apps/server/src/test/helpers.ts 的 resetDb() / createTestApp()），沒有純粹
  不碰資料庫的邏輯可獨立拆成 unit tier。
-->

## dev-seed-account

### Requirement: 建立固定測試帳號

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `seed_creates_user_when_absent` | 帳號不存在時建立 | `users` 表查無該 email → 呼叫 `seedDevUser({ email, password })` 後新增一筆列，`password` 欄位以 `bcrypt.compare(明文, 雜湊)` 驗證通過，且不等於明文本身 | golden path | integration |
| `seed_skips_when_already_exists` | 帳號已存在時略過 | 先建立一筆該 email 的帳號 → 再呼叫 `seedDevUser({ email, password })` → `users` 表該 email 列數仍為 1，函式正常 resolve、不拋出例外 | 邊界：冪等性是核心需求 | integration |

### Requirement: 帳密內容可覆寫，未提供時使用預設值

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `seed_uses_provided_overrides` | 提供覆寫值 | 呼叫 `seedDevUser({ email: "custom@example.com", password: "custom1234" })` → `users` 表新增列 email 為 `custom@example.com` | golden path | integration |
| `seed_uses_default_when_no_overrides` | 未提供覆寫值 | 呼叫 `seedDevUser()`（不帶參數）→ `users` 表新增列 email 為 `env.SEED_USER_EMAIL` 的值（預設 `dev@example.com`） | edge case：預設值路徑必須有測試覆蓋 | integration |

### Requirement: Seed 帳號可用於實際登入

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `seeded_account_can_login_via_auth_login` | 以 seed 帳密登入 | 呼叫 `seedDevUser({ email, password })` → 以同組明文帳密打 `POST /auth/login` → 200 且回傳 token；帶該 token 打 `GET /auth/me` → 200 | golden path，端到端驗證「真的能登入」而非只是資料庫有列 | integration |

---

## Checklist

- [x] Every requirement has at least one matching test
- [x] Every Scenario (####) has at least one matching test（帳號不存在／已存在／
      提供覆寫／未提供覆寫／登入成功，五個 Scenario 對五個測試）
- [x] Every row has a Tier value（unit | integration | e2e）
- [x] Test names use imperative form（避免 `test_1`、`it_works`）
