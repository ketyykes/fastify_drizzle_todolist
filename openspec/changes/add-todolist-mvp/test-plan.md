# Test Plan: add-todolist-mvp

<!--
  RED-phase commitment document。只描述「測什麼、預期結果、為何先寫」，不寫實作邏輯。
  Tier 欄位每列必填（unit | integration | e2e）。
  後端整合測試以 Fastify `app.inject()` 打端點、對測試用 Postgres 驗證。
-->

## user-auth

### Requirement: 使用者註冊

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `register_creates_user_and_returns_token` | 以全新 email 註冊成功 | POST /auth/register {新 email, 合法 pw} → 201 且 body 含 `token`；DB `users` 新增一列 | golden path | integration |
| `register_hashes_password_not_plaintext` | 以全新 email 註冊成功 | 註冊後查 DB → `password` 欄非明文（bcrypt hash，`$2` 前綴） | 安全不可回頭 | integration |
| `register_rejects_duplicate_email` | email 已存在 | 對已存在 email 再註冊 → 409 且不新增第二列 | edge case | integration |
| `register_rejects_invalid_input` | 輸入不合法 | 缺 email / pw 或格式錯 → 400，DB 無新增 | 驗證守門 | integration |

### Requirement: 使用者登入

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `login_returns_token_on_valid_credentials` | 帳密正確 | POST /auth/login {正確 email/pw} → 200 且 body 含可驗證的 JWT（解出含 userId） | golden path | integration |
| `login_rejects_wrong_credentials` | 帳密錯誤 | 錯 email 或錯 pw → 401，訊息不區分帳號不存在／密碼錯 | 安全邊界 | integration |

### Requirement: 取得目前使用者資料

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `me_returns_current_user_without_password` | 持有效 token 查詢 | 帶有效 Bearer → 200 且 body = `{ id, email }`，不含 password | golden path | integration |
| `me_rejects_missing_or_invalid_token` | 未帶或無效 token 查詢 | 無 token / 亂 token → 401 | regression guard | integration |

### Requirement: 登出

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `logout_clears_token_and_redirects` | 使用者登出 | 呼叫前端 logout → localStorage token 被移除、auth atom 清空、導向 /login | golden path | unit |

### Requirement: 受保護端點授權

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `authenticate_allows_valid_token` | 有效 token 放行 | 帶有效 Bearer 存取受保護端點 → 通過，處理函式取得 userId | golden path | integration |
| `authenticate_blocks_invalid_token` | 缺少或無效 token 拒絕 | 無 token / 過期 / 簽章不符 → 401 且中止 | 安全邊界 | integration |

## todo-management

### Requirement: 建立 Todo

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `create_todo_persists_for_current_user` | 建立成功 | 帶 token POST /todos {title} → 201，回傳 todo 且 `user_id` = 目前使用者、`completed=false` | golden path | integration |
| `create_todo_rejects_empty_title` | title 為空 | title 缺或空字串 → 400，DB 無新增 | edge case | integration |

### Requirement: 列出自己的 Todos

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `list_todos_returns_only_own` | 只看到自己的資料 | 使用者 A GET /todos → 僅含 A 的 todos，不含 B 的 | 隔離守門 | integration |

### Requirement: 切換 Todo 完成狀態

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `patch_todo_updates_completed` | 更新自己的 todo | 帶 token PATCH /todos/:id {completed:true} → 200，DB 該列 completed=true | golden path | integration |
| `patch_todo_returns_404_when_missing` | 更新不存在的 todo | PATCH 不存在 id → 404 | edge case | integration |

### Requirement: 刪除 Todo

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `delete_todo_removes_own` | 刪除自己的 todo | 帶 token DELETE /todos/:id → 204，DB 該列消失 | golden path | integration |

### Requirement: 跨使用者資料隔離

| Test name | Scenario | Assertion | Why first | Tier |
|-----------|----------|-----------|-----------|------|
| `patch_others_todo_returns_404` | 存取他人 todo 被拒 | A 對 B 的 todo PATCH → 404 且 B 的資料不變 | 安全邊界 | integration |
| `delete_others_todo_returns_404` | 存取他人 todo 被拒 | A 對 B 的 todo DELETE → 404 且 B 的資料仍在 | 安全邊界 | integration |
| `list_excludes_other_users_todos` | 列表不外洩 | A GET /todos → 結果不含任何 user_id≠A 的 todo | 隔離守門 | integration |

---

## Checklist

- [x] Every requirement has at least one matching test
- [x] Every Scenario (####) has at least one matching test
- [x] Every row has a Tier value (unit | integration | e2e)
- [x] Test names use imperative form (avoid `test_1`, `it_works`)
