# Specification: dev-seed-account

## ADDED Requirements

### Requirement: 建立固定測試帳號

系統 SHALL 在執行 seed 時，若 `users` 表中查無指定 email 的帳號，建立一筆密碼經
bcrypt 雜湊（非明文）的新帳號；若該 email 已存在帳號，SHALL 略過建立，不得拋出例外
或產生重複列。

#### Scenario: 帳號不存在時建立

- **WHEN** 執行 seed 且 `users` 表中查無指定 email 的帳號
- **THEN** 新增一筆帳號，其 `password` 欄位為 bcrypt 雜湊值（非明文），且能以原始
  明文密碼通過 `bcrypt.compare`

#### Scenario: 帳號已存在時略過

- **WHEN** 執行 seed 且 `users` 表中已存在指定 email 的帳號
- **THEN** 不新增任何列，`users` 表中該 email 對應的列數維持 1，且腳本正常結束、
  不拋出例外

### Requirement: 帳密內容可覆寫，未提供時使用預設值

系統 SHALL 允許以參數（對應環境變數 `SEED_USER_EMAIL` / `SEED_USER_PASSWORD`）指定
要 seed 的 email 與密碼；未提供時 SHALL 使用內建預設值。

#### Scenario: 提供覆寫值

- **WHEN** 呼叫 seed 邏輯時指定 email 與 password
- **THEN** 建立（或比對是否存在）的帳號使用該指定的 email，密碼雜湊對應該指定的
  明文密碼

#### Scenario: 未提供覆寫值

- **WHEN** 呼叫 seed 邏輯時未指定 email 與 password
- **THEN** 使用內建預設 email 與密碼建立（或比對）帳號

### Requirement: Seed 帳號可用於實際登入

系統 SHALL 保證 seed 建立的帳號能透過既有 `POST /auth/login` 端點，以相同明文密碼
成功登入並取得可用的 JWT。

#### Scenario: 以 seed 帳密登入

- **WHEN** 以 seed 使用的 email 與明文密碼呼叫 `POST /auth/login`
- **THEN** 回應狀態碼 200，且回傳的 JWT 可用於呼叫 `GET /auth/me` 並取得 200
