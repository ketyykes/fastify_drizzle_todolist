# Specification: todo-management

## ADDED Requirements

### Requirement: 建立 Todo

系統 SHALL 提供受保護的 `POST /todos` 端點，讓已登入使用者以 `title` 建立一筆屬於自己的 todo，預設 `completed` 為 `false`。

#### Scenario: 建立成功

- **WHEN** 已登入使用者攜帶有效 Bearer token、以非空 `title` 呼叫 `POST /todos`
- **THEN** 系統建立一筆 `user_id` 等於該使用者的 todo，`completed` 預設為 `false`，回傳 HTTP 201 與新建的 todo

#### Scenario: title 為空

- **WHEN** 請求的 `title` 缺少或為空字串
- **THEN** 系統回傳 HTTP 400 並不建立紀錄

### Requirement: 列出自己的 Todos

系統 SHALL 提供受保護的 `GET /todos` 端點，只回傳目前使用者自己的 todos。

#### Scenario: 只看到自己的資料

- **WHEN** 已登入使用者呼叫 `GET /todos`
- **THEN** 系統回傳 HTTP 200 與一個陣列，其中僅包含 `user_id` 等於該使用者的 todos，不含其他使用者的資料

### Requirement: 切換 Todo 完成狀態

系統 SHALL 提供受保護的 `PATCH /todos/:id` 端點，讓使用者更新自己 todo 的 `completed`（或 `title`）。

#### Scenario: 更新自己的 todo

- **WHEN** 已登入使用者對自己擁有的 todo 呼叫 `PATCH /todos/:id` 並帶入 `completed`
- **THEN** 系統更新該筆 todo 並回傳 HTTP 200 與更新後的 todo

#### Scenario: 更新不存在的 todo

- **WHEN** 使用者對不存在的 `:id` 呼叫 `PATCH /todos/:id`
- **THEN** 系統回傳 HTTP 404

### Requirement: 刪除 Todo

系統 SHALL 提供受保護的 `DELETE /todos/:id` 端點，讓使用者刪除自己的 todo。

#### Scenario: 刪除自己的 todo

- **WHEN** 已登入使用者對自己擁有的 todo 呼叫 `DELETE /todos/:id`
- **THEN** 系統刪除該筆 todo 並回傳 HTTP 204

### Requirement: 跨使用者資料隔離

系統 SHALL 確保所有 todos 操作皆以目前 token 的 `userId` 過濾；使用者 MUST NOT 讀取、修改或刪除不屬於自己的 todo。

#### Scenario: 存取他人 todo 被拒

- **WHEN** 使用者 A 對一筆屬於使用者 B 的 todo 呼叫 `PATCH` 或 `DELETE`
- **THEN** 系統視為不存在，回傳 HTTP 404，且不修改或刪除該筆資料

#### Scenario: 列表不外洩

- **WHEN** 使用者 A 呼叫 `GET /todos`
- **THEN** 回傳結果 MUST NOT 包含任何 `user_id` 不等於 A 的 todo
