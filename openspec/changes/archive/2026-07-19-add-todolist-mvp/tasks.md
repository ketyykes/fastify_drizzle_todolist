# Tasks: add-todolist-mvp

<!--
  Apply parses `- [ ]` checkboxes to track progress.
  §0、§5、§6 為無法單元測試驅動的基礎建設 / UI 接線 / 容器設定，明確標示為非 TDD；
  其餘群組一律 RED → GREEN 配對，對齊 test-plan.md。
  測試名稱皆取自 test-plan.md。整合測試以 buildApp() + app.inject() 對測試用 Postgres 執行。
-->

## 0. 前置基礎建設（非 TDD，後續 RED 依賴）

- [x] 0.1 以 fnm 套用 `.node-version`（Node 22.22.2）、`pnpm install`
- [x] 0.2 安裝 server 依賴：`@fastify/jwt`、`bcryptjs`、`@types/bcryptjs`
- [x] 0.3 `packages/env/src/server.ts` env schema 新增 `JWT_SECRET`（`z.string().min(1)`）與可選 `PORT`
- [x] 0.4 建立 server 整合測試基礎：vitest 設定、測試用 Postgres 連線、`buildApp()` app factory（供 `app.inject()`）、每次測試前跑 `db:push` 對齊 schema 的輔助
- [x] 0.5 `apps/server/src/index.ts` 改用 `buildApp()` 並讀 `env.PORT`（移除寫死的 `3000`）

## 1. 註冊 (user-auth)
Depends on: §0

- [x] 1.1 RED: 寫測試 `register_creates_user_and_returns_token`
- [x] 1.2 GREEN: 建立 `packages/db` 的 `users` schema（`id`/`email` unique/`password`/`created_at`）並匯出；註冊 `@fastify/jwt` plugin；實作 `POST /auth/register`（zod 驗證 → bcrypt 雜湊 → insert → `jwt.sign({userId})` → 201 `{ token }`）
- [x] 1.3 RED: 寫測試 `register_hashes_password_not_plaintext`
- [x] 1.4 GREEN: 確保 `users.password` 存 bcrypt 雜湊（`$2` 前綴），非明文
- [x] 1.5 RED: 寫測試 `register_rejects_duplicate_email`
- [x] 1.6 GREEN: 對已存在 email 回 409（唯一鍵衝突處理）
- [x] 1.7 RED: 寫測試 `register_rejects_invalid_input`
- [x] 1.8 GREEN: 以 zod 驗證 email 格式與 password 最小長度，不合法回 400

## 2. 登入與授權 (user-auth)
Depends on: §1

- [x] 2.1 RED: 寫測試 `login_returns_token_on_valid_credentials`
- [x] 2.2 GREEN: 實作 `POST /auth/login`（bcrypt 比對 → `jwt.sign({userId})` → 200 `{ token }`）
- [x] 2.3 RED: 寫測試 `login_rejects_wrong_credentials`
- [x] 2.4 GREEN: 帳號不存在或密碼錯皆回一致的 401（不洩漏存在性）
- [x] 2.5 RED: 寫測試 `authenticate_allows_valid_token`
- [x] 2.6 GREEN: 建立 `authenticate` preHandler（`request.jwtVerify()`，成功將 `userId` 附於 request）
- [x] 2.7 RED: 寫測試 `authenticate_blocks_invalid_token`
- [x] 2.8 GREEN: token 缺少 / 格式錯 / 過期 / 簽章不符皆回 401 並中止
- [x] 2.9 RED: 寫測試 `me_returns_current_user_without_password`
- [x] 2.10 GREEN: 實作受保護的 `GET /auth/me`，回傳 `{ id, email }`（排除 password）
- [x] 2.11 RED: 寫測試 `me_rejects_missing_or_invalid_token`
- [x] 2.12 GREEN: 將 `authenticate` 套用於 `GET /auth/me`

## 3. Todos CRUD 與隔離 (todo-management)
Depends on: §2

- [x] 3.1 RED: 寫測試 `create_todo_persists_for_current_user`
- [x] 3.2 GREEN: 建立 `todos` schema（`id`/`user_id`→users/`title`/`completed` 預設 false/`created_at`）並匯出；實作受保護 `POST /todos`（以 token 的 `userId` 建立、回 201）
- [x] 3.3 RED: 寫測試 `create_todo_rejects_empty_title`
- [x] 3.4 GREEN: 以 zod 驗證 `title` 非空，空值回 400
- [x] 3.5 RED: 寫測試 `list_todos_returns_only_own`
- [x] 3.6 GREEN: 實作受保護 `GET /todos`，`where user_id = currentUserId`
- [x] 3.7 RED: 寫測試 `patch_todo_updates_completed`
- [x] 3.8 GREEN: 實作受保護 `PATCH /todos/:id`（限本人、更新 `completed`/`title` → 200）
- [x] 3.9 RED: 寫測試 `patch_todo_returns_404_when_missing`
- [x] 3.10 GREEN: 找不到（含非本人）回 404
- [x] 3.11 RED: 寫測試 `delete_todo_removes_own`
- [x] 3.12 GREEN: 實作受保護 `DELETE /todos/:id`（限本人 → 204）
- [x] 3.13 RED: 寫測試 `patch_others_todo_returns_404`
- [x] 3.14 GREEN: `PATCH` 查詢條件加入 `user_id = currentUserId`，他人資源回 404 且不變更
- [x] 3.15 RED: 寫測試 `delete_others_todo_returns_404`
- [x] 3.16 GREEN: `DELETE` 查詢條件加入 `user_id = currentUserId`，他人資源回 404 且不刪除
- [x] 3.17 RED: 寫測試 `list_excludes_other_users_todos`
- [x] 3.18 GREEN: 驗證 §3.6 的過濾條件已排除他人 todo（無需新程式，僅補驗證）

## 4. 前端認證接線 (web)
Depends on: §2

- [x] 4.1 RED: 寫測試 `logout_clears_token_and_redirects`
- [x] 4.2 GREEN: 建立 auth store（jotai atom + localStorage 同步）與 `login`/`register`/`logout` 函式；`http-client.ts` 加 request interceptor 附 `Authorization: Bearer` 與 401 攔截導回 `/login`

## 5. 前端頁面與路由（UI 接線，非 TDD）
Depends on: §4

- [x] 5.1 建立 login 頁（`@tanstack/react-form` + zod + shadcn `input`/`button`/`card`/`label`），呼叫 login 後存 token 並導向 `/todos`
- [x] 5.2 建立 register 頁（同上表單堆疊），呼叫 register 後導向 `/todos`
- [x] 5.3 建立 todos 頁：列表、新增（input + button）、切換完成（shadcn `checkbox`）、刪除
- [x] 5.4 `router.tsx` 加受保護路由包裝（無 token 導回 `/login`）；header 加登出鈕與 `sonner` toast 回饋
- [x] 5.5 前端 `VITE_SERVER_URL` 指向 `http://localhost:3001`

## 6. 容器與設定（非 TDD）
Depends on: §3

- [x] 6.1 改寫根 `docker-compose.yml`：`server` 改 dev 容器（Node 22 base、bind-mount、`pnpm --filter server dev` tsx watch），啟動先 `pnpm db:push` 建表；補 `CORS_ORIGIN=http://localhost:5173`、`JWT_SECRET`、`DATABASE_URL=postgresql://postgres:password@db:5432/...`；`db` 用 `postgres:16-alpine`；移除前端 compose 服務
- [x] 6.2 手動端到端驗證：`docker compose up` 起後端+DB，本機 `pnpm dev:web`，跑完整流程（註冊 → 登入 → 新增/打勾/刪除 todo → 登出）並確認跨使用者隔離
