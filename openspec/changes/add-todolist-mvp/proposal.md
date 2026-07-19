# Proposal: add-todolist-mvp

## Why

目前專案是一個 better-t-stack scaffold 出來的空殼：前端只有一個顯示 ASCII 大字的 Home、後端只有 `GET /` 回 `"OK"`、資料庫只有一張無用的 `example` 表，完全沒有登入或任何業務資料。我們需要一個能從零跑完整流程（註冊 → 登入 → 管理自己的 todos → 登出）的最小 MVP，並讓後端與資料庫以 Docker 啟動，前端本機連進去即可開發。

## What Changes

- 新增使用者認證：`register` / `login` / `logout` / `me`，採 JWT + Bearer token（token 存前端 localStorage，透過 axios interceptor 帶 `Authorization: Bearer`）。
- 新增 per-user 的 todos CRUD：列表 / 新增 / 切換完成 / 刪除，且每位使用者只看得到自己的 todos。
- 資料層新增 `users` 與 `todos` 兩張 Drizzle schema（沿用或移除既有 `example` 表）。
- 後端新增 `@fastify/jwt` 與 `bcryptjs`，`env` schema 補上 `JWT_SECRET`。
- **BREAKING**（相對現有 scaffold 設定）：`docker-compose.yml` 改為 dev 容器模式 —— `server` 服務改用 `tsx watch` + bind-mount 熱更新、補齊 `CORS_ORIGIN` / `JWT_SECRET` / 指向 `db:5432` 的 `DATABASE_URL`，並在啟動時先 `pnpm db:push` 建表；移除前端相關的 compose 服務（前端改本機 `vite dev`）。
- 修正既有地雷：`server/src/index.ts` 寫死的 `port: 3000` 改讀 `env.PORT`。

## Capabilities

### New Capabilities

- `user-auth`: 使用者註冊、登入、登出與取得自身資料；密碼以 bcrypt 雜湊儲存，登入後簽發 JWT，受保護端點以 Bearer token 驗證。
- `todo-management`: 已登入使用者對自己的 todos 進行建立、查詢、切換完成狀態與刪除；資料以 `user_id` 隔離，跨使用者不可存取。

### Modified Capabilities

<!-- 無既有 capability 需修改 -->

## Impact

- **前端 `apps/web`**：新增 `login` / `register` / `todos` 路由與受保護路由包裝；`http-client.ts` 加上 request interceptor（附 Bearer）與 401 攔截導回登入；以 jotai atom 保存 token；header 加登出鈕。無需新增套件（axios / jotai / react-router / @tanstack/react-form / zod / shadcn 皆已具備）。
- **後端 `apps/server`**：新增 `routes/auth.ts` 與 `routes/todos.ts`、`authenticate` preHandler；註冊 `@fastify/jwt` plugin。新增依賴 `@fastify/jwt`、`bcryptjs`、`@types/bcryptjs`。
- **資料層 `packages/db`**：新增 `schema/users.ts`、`schema/todos.ts` 並於 `schema/index.ts` 匯出。
- **環境設定 `packages/env`**：`server.ts` 的 env schema 新增 `JWT_SECRET`（與可選的 `PORT`）。
- **Docker / 設定**：改寫根目錄 `docker-compose.yml`（server 改 dev 容器、補環境變數、啟動先建表）。
- **外部系統**：無；僅本機 Docker（Postgres 16 + Node dev 容器）與本機 Vite dev server。
