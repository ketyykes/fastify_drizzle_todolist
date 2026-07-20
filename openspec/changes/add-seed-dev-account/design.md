# Design: add-seed-dev-account

## Context

專案目前沒有任何 seed 機制；新電腦第一次啟動只能靠手動 `POST /auth/register`。
`docker-compose.yml` 的 `server` service 每次啟動已固定跑
`pnpm db:push`（同步 schema），這是本次要接掛的位置。`packages/env` 用 t3-env
（`createEnv`）+ zod，`emptyStringAsUndefined: true`，選填變數皆用 `.default(...)`
（例如既有的 `OUTBOX_WEBHOOK_URL`）。`apps/server/src/outbox/config.ts` 有「env 讀值
+ `setOutboxConfigForTest()` 測試覆寫」的先例，本次評估後改用更輕量的函式參數覆寫
（見下方 Decision）。

## Goals

- 任何全新環境（新電腦、全新 volume）`docker compose up` 後即具備一組固定測試帳密，
  免手動註冊。
- 帳密可由根目錄 `.env` 覆寫，未設定時使用內建預設值。
- 重複執行安全（idempotent），不因多次啟動／重啟容器而報錯或產生重複資料。
- 不影響測試資料庫（`_test`）與既有整合測試的 `resetDb()` 流程。

## Non-Goals

- 不做通用的「多筆假資料」seed 框架（例如附帶的 todos 假資料、多組測試帳號）；只做
  這一組固定帳號。
- 不做「更新既有帳號密碼」的 upsert 邏輯；email 已存在就完全略過，即使
  `SEED_USER_PASSWORD` 設定值後來改變，也不會回頭更新舊帳號（見 Decision）。
- 不動測試資料庫（`fastify_drizzle_todolist_test`）；`db:push:test` / `resetDb()`
  流程不受影響。
- 不建立像 `outbox/config.ts` 那種專門的 `setXxxForTest()` 覆寫模組；改用函式參數
  注入（見 Decision）。

## Decisions

### Decision: 已存在的 email 一律略過，不做 upsert 更新密碼

**Choice**: seed 邏輯只在 email 不存在時 insert；email 已存在時單純 return，不比對
或更新密碼。

**Rationale**: 語意最單純，跟 `/auth/register` 現有的「email 已存在即拒絕」邏輯一致；
避免「改了 `SEED_USER_PASSWORD` 之後重啟容器，悄悄覆寫掉使用者手動改過的密碼」這種
意外行為。

**Alternatives considered**:
- Upsert（email 存在則更新密碼雜湊）：能讓「改 env 就換密碼」更直覺，但會在使用者
  於本機手動改過該帳號密碼後，因容器重啟被悄悄覆寫，行為較不可預期，也不是使用者
  提出的需求。

### Decision: 帳密覆寫用函式參數，不比照 outbox 的 setXxxForTest() 模組

**Choice**: `seedDevUser(overrides?: { email?: string; password?: string })`，未帶
參數時讀 `env.SEED_USER_EMAIL` / `env.SEED_USER_PASSWORD`（其值已由 t3-env/zod
`.default(...)` 處理過），測試直接傳入覆寫值。

**Rationale**: `packages/env` 的 `env` 物件在模組載入當下就用 `process.env` 解析
完成，測試中途改 `process.env.SEED_USER_EMAIL` 不會反映到已載入的 `env`；
`outbox/config.ts` 是用專門的 `setOutboxConfigForTest()` 繞過這個限制，但那是給
「同一支長駐 worker/sweeper 需要在多個測試案例間切換設定」用的。這次只有一個
一次性腳本、邏輯單純，直接讓函式接受覆寫參數更省一層模組，符合「簡單就好」的
需求。

**Alternatives considered**:
- 比照 `outbox/config.ts` 寫一個 `seed-config.ts` + `setSeedUserConfigForTest()`：
  多一層模組，對這麼小的功能是不必要的抽象。
- 靠改 `process.env` 後動態 re-import 模組：vitest 動態 re-import 較脆弱、易產生
  模組快取問題，不採用。

### Decision: bcrypt rounds 常數在 seed 腳本內重複宣告，不從 auth.ts 抽出共用

**Choice**: `seed-dev-user.ts` 內自行宣告 `const BCRYPT_ROUNDS = 10`，不修改
`auth.ts` 去 export 共用常數。

**Rationale**: 只有一個數字常數在兩個檔案重複，抽出共用模組的成本（多一個檔案、
多一次 import）大於重複本身；`auth.ts` 目前不對外 export 任何內部常數，為了單一
seed 腳本去改動既有認證路由的匯出面，範圍不成比例。

**Alternatives considered**:
- 抽出 `apps/server/src/lib/password.ts` 提供共用的 `hashPassword()`：等未來真的
  出現第三個呼叫點再做，目前屬於過早抽象。

### Decision: docker-compose 環境變數用 `${VAR:-}` 空字串預設語法

**Choice**: `server` service 的 `environment:` 加上
`SEED_USER_EMAIL: ${SEED_USER_EMAIL:-}` 與 `SEED_USER_PASSWORD: ${SEED_USER_PASSWORD:-}`。
根目錄 `.env` 沒設定時代入空字串，容器內 `process.env.SEED_USER_EMAIL === ""`，
經 `packages/env` 的 `emptyStringAsUndefined: true` 視為未設定，落到 zod
`.default(...)`。

**Rationale**: 這是 `packages/env` 既有的既定機制，沿用同一套規則最一致；`${VAR:-}`
是 docker compose 標準語法，不需要在根目錄 `.env.example` 強制要求填值。

**Alternatives considered**:
- 不接進 `docker-compose.yml`，只留 code 內建預設值：使用者已在討論中明確選擇
  「要能用 `.env` 覆寫」，故排除。

## Risks / Trade-offs

- [Risk] 預設密碼 `dev12345` 若被誤用在正式環境會是已知的安全風險 →
  Mitigation：僅供本機開發（compose 網路不對外開放任何此帳號的特權操作），
  `CLAUDE.md` 與 `.env.example` 明確註記「僅供本機測試，正式環境務必覆寫或移除」。
- [Risk] Email 已存在但密碼被使用者手動更改後，seed 不會提示任何差異（因為完全
  略過）→ Mitigation：這是刻意選擇（見上方 Decision），文件中說明「只在首次建立
  時生效」。
- [Risk] `docker-compose.yml` 的啟動指令鏈用 `&&` 串接，若 seed 腳本意外拋出未
  預期例外會擋住 `pnpm --filter server dev` 啟動 → Mitigation：邏輯單純（查詢＋
  條件式 insert），與 `db:push` 本來就會因連線失敗而擋住的風險等級一致，不特別
  加 try/catch 吞例外。

## Migration Plan

無資料遷移，純新增行為。部署／驗證步驟：

1. `pnpm db:seed`（或全新環境跑 `docker compose up`）建立測試帳號。
2. 用預設或覆寫後的帳密呼叫 `POST /auth/login` 驗證能登入。
3. Rollback：純新增檔案與設定，回退只需 revert 這次的 commit；已存在的 seed 帳號
   如需清除，手動 `DELETE FROM users WHERE email = '...'`（不提供自動反向腳本，
   範圍超出本次需求）。

## Open Questions

<!-- 無 -->
