# Specification: user-auth

## Purpose

提供以 JWT 為基礎的使用者身分驗證能力，涵蓋註冊、登入、取得目前使用者資料、登出，以及受保護端點的授權檢查。

## Requirements

### Requirement: 使用者註冊

系統 SHALL 提供 `POST /auth/register` 端點，接受 `email` 與 `password`，成功時以 bcrypt 雜湊儲存密碼、建立使用者，並回傳一組已簽發的 JWT。

#### Scenario: 以全新 email 註冊成功

- **WHEN** 使用者以尚未註冊的合法 `email` 與符合長度要求的 `password` 呼叫 `POST /auth/register`
- **THEN** 系統建立一筆 `users` 紀錄、密碼以 bcrypt 雜湊儲存（不得明文保存），並回傳 HTTP 201 與 `{ token }`

#### Scenario: email 已存在

- **WHEN** 使用者以一個已存在的 `email` 呼叫 `POST /auth/register`
- **THEN** 系統回傳 HTTP 409，且不建立重複紀錄

#### Scenario: 輸入不合法

- **WHEN** 請求缺少 `email` 或 `password`，或 `email` 格式錯誤、`password` 短於最小長度
- **THEN** 系統回傳 HTTP 400 並附驗證錯誤訊息，不建立任何紀錄

### Requirement: 使用者登入

系統 SHALL 提供 `POST /auth/login` 端點，驗證 `email` 與 `password`，通過時簽發包含使用者識別的 JWT 並回傳。

#### Scenario: 帳密正確

- **WHEN** 使用者以正確的 `email` 與 `password` 呼叫 `POST /auth/login`
- **THEN** 系統以 bcrypt 比對雜湊成功，簽發內含 `userId` 的 JWT，回傳 HTTP 200 與 `{ token }`

#### Scenario: 帳密錯誤

- **WHEN** 使用者以不存在的 `email` 或錯誤的 `password` 呼叫 `POST /auth/login`
- **THEN** 系統回傳 HTTP 401，且錯誤訊息不得洩漏「是帳號不存在還是密碼錯誤」

### Requirement: 取得目前使用者資料

系統 SHALL 提供受保護的 `GET /auth/me` 端點，回傳目前 Bearer token 對應使用者的公開資料（`id`、`email`），且不得回傳密碼雜湊。

#### Scenario: 持有效 token 查詢

- **WHEN** 已登入使用者攜帶有效的 `Authorization: Bearer <token>` 呼叫 `GET /auth/me`
- **THEN** 系統回傳 HTTP 200 與 `{ id, email }`

#### Scenario: 未帶或無效 token 查詢

- **WHEN** 呼叫 `GET /auth/me` 時未附 token 或 token 無效／過期
- **THEN** 系統回傳 HTTP 401

### Requirement: 登出

系統 SHALL 支援登出流程；因 JWT 為無狀態，登出 SHALL 由前端移除本地保存的 token 完成，伺服器端不需維護 token 狀態。

#### Scenario: 使用者登出

- **WHEN** 已登入使用者於前端觸發登出
- **THEN** 前端自 localStorage 移除 token 並導向登入頁，後續請求不再攜帶 `Authorization` 標頭

### Requirement: 受保護端點授權

系統 SHALL 以 preHandler 驗證 `Authorization: Bearer <token>`，僅在 token 有效時放行受保護端點，並將解析出的 `userId` 提供給後續處理。

#### Scenario: 有效 token 放行

- **WHEN** 請求攜帶有效且未過期的 Bearer token 存取受保護端點
- **THEN** 系統驗證通過，將 `userId` 附於請求情境並繼續處理

#### Scenario: 缺少或無效 token 拒絕

- **WHEN** 請求存取受保護端點但未附 token、token 格式錯誤、簽章不符或已過期
- **THEN** 系統回傳 HTTP 401 並中止處理
