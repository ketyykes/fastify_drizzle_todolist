# Design: add-todolist-mvp

## Context

專案為 better-t-stack scaffold 出的 pnpm monorepo：`apps/web`（React 19 + Vite 8 + react-router 8 + jotai + axios + shadcn/tailwind）、`apps/server`（Fastify 5 + zod）、`packages/db`（Drizzle + node-postgres，僅一張 `example` 表）、`packages/env`（t3-env）。目前無任何 auth 與業務資料。目標是最小 MVP：後端與 DB 以 Docker 啟動、前端本機 `vite dev` 連進去，具備 JWT + Bearer 的登入登出與 per-user todos CRUD。

約束與已知現況：
- 前端 `http-client.ts` 已備 axios 實例，baseURL 取自 `env.VITE_SERVER_URL`（預設 `http://localhost:3000`）。
- 後端 `env.server` 需 `DATABASE_URL`、`CORS_ORIGIN`（`z.url()` 無預設）、`NODE_ENV`。
- 本機 Node 原為 v18，跑不動 vitest 4 / rolldown（需 `node:util` 的 `styleText`，Node 20.12+/22+）；已改用 fnm 切至 **Node 22.22.2** 並新增 `.node-version`。

## Goals

- 從零跑完整流程：註冊 → 登入 → 管理自己的 todos → 登出。
- 後端 + Postgres 以 `docker compose up` 一鍵啟動；前端本機開發即可連上。
- 認證採 JWT + Bearer token；受保護端點以 preHandler 驗證。
- todos 以 `user_id` 隔離，跨使用者不可存取。

## Non-Goals

- refresh token / token 輪替 / 伺服器端 token 黑名單（無狀態登出即可）。
- 前端容器化與 production 部署（前端維持本機 `vite dev`）。
- 進階功能：分頁、搜尋、標籤、到期日、多人協作、email 驗證、忘記密碼。
- production 級 Docker 多階段 build（本次採 dev 容器）。

## Decisions

### Decision: Token 傳輸採 Bearer + localStorage

**Choice**: 登入回傳 `{ token }`（JSON body），前端存 localStorage，透過 axios request interceptor 附 `Authorization: Bearer <token>`；登出即前端移除 token。

**Rationale**: 完全符合原始需求「JWT + bearer token」；套件最少（前端 0 新增）；header-based 無 CSRF 疑慮；跨來源最單純（後端 CORS 已允許 `Authorization` 標頭）。

**Alternatives considered**:
- httpOnly cookie：對 XSS 較安全，但需 `@fastify/cookie`、前端 `withCredentials`、額外 logout endpoint 與 CSRF 考量，且已非傳統 Bearer 語義 —— 與「最小、貼需求」目標相悖。
- 非 httpOnly cookie：同時吃到 localStorage 的 XSS 風險與 cookie 的跨來源麻煩，無意義，排除。

### Decision: JWT 用 @fastify/jwt

**Choice**: 後端註冊 `@fastify/jwt` plugin，以 `fastify.jwt.sign()` 簽發、以 `request.jwtVerify()` 於 `authenticate` preHandler 驗證。

**Rationale**: Fastify 官方 plugin，與 decorator / preHandler 生命週期整合最自然，型別完善。

**Alternatives considered**:
- `jsonwebtoken`：可行但需自行接進 preHandler 與錯誤處理，較不 idiomatic。
- `jose`：功能強但對本 MVP 過重。

### Decision: 密碼雜湊用 bcryptjs

**Choice**: 使用純 JS 的 `bcryptjs`。

**Rationale**: 無原生編譯相依，於 alpine / dev 容器安裝零摩擦；MVP 對雜湊效能不敏感。

**Alternatives considered**:
- `bcrypt`（原生）：需 node-gyp 編譯，Docker/alpine 常見雷。
- `argon2`：更現代但同樣需原生編譯，對 MVP 過重。

### Decision: 後端採 dev 容器（tsx watch + bind-mount）

**Choice**: `docker-compose.yml` 的 `server` 服務改用 Node 22 base image、bind-mount 專案原始碼、以 `pnpm --filter server dev`（tsx watch）啟動，改檔即時重載；啟動前先 `pnpm db:push` 建表。`db` 服務用 `postgres:16-alpine`。

**Rationale**: 符合「後端也用 Docker」且不必重寫既有 monorepo Dockerfile（該檔以 `./apps/server` 為 context、複製不存在的 lockfile，production build 會失敗）；dev 容器熱更新最利於 MVP 迭代。

**Alternatives considered**:
- production 多階段 build：需重寫 Dockerfile 支援 pnpm workspace（root context + workspace 打包），工較多、改碼要 rebuild，非 MVP 所需。
- 只有 DB 進 Docker、後端本機跑：最省事但不符合需求明述「後端也用 Docker」。

### Decision: 前端維持本機，不進 Docker

**Choice**: 前端以本機 `vite dev` 執行，`VITE_SERVER_URL` 指向 `http://localhost:7529`（後端 host 映射埠，選用冷門埠避免撞本機服務）。

**Rationale**: React 在**瀏覽器**執行，連不到 Docker 內部主機名（如 `server:7529`）；`VITE_*` 亦為 build 時烙入、runtime 設 compose env 無效。前端本機直連 host 映射埠可完全避開這些坑。

**Alternatives considered**:
- 前端也進 Docker：需以 build arg 傳入可從瀏覽器抵達的 API URL，並跑 nginx 提供靜態檔，對 MVP 過重且易誤設（現有 compose 的 `VITE_API_URL=http://server:3001` 正是三重錯示範）。

### Decision: schema 以 db:push 建表（不寫 migration）

**Choice**: dev 容器啟動時執行 `pnpm db:push` 讓 Drizzle 直接同步 schema 到 Postgres。

**Rationale**: MVP 免維護 migration 檔；`db:push` 對快速迭代最省事。

**Alternatives considered**:
- `drizzle-kit generate` + migrate：正式環境較嚴謹，但對單機 MVP 是額外負擔。

### Decision: 跨使用者存取回 404 而非 403

**Choice**: 所有 todos 查詢一律以 `where user_id = :currentUserId` 過濾；操作他人 todo 時視為不存在回 404。

**Rationale**: 不洩漏「該筆是否存在」，同時實作最單純（查詢天然過濾即可，無需先查再比對）。

**Alternatives considered**:
- 回 403：需先查 todo 再比對擁有者，多一次查詢且洩漏存在性。

## Risks / Trade-offs

- [Risk] localStorage 存 JWT，XSS 可竊 token → Mitigation：MVP 範圍接受；限制 token 有效期、前端避免注入未淨化 HTML；未來可升級 httpOnly cookie。
- [Risk] 無狀態登出無法即時撤銷 token（token 到期前仍有效）→ Mitigation：設定較短有效期（如 1 天）；MVP 不需即時撤銷。
- [Risk] dev 容器 bind-mount 時容器內外 `node_modules` 平台不一致 → Mitigation：於容器內 `pnpm install` 並以 volume 隔離 `node_modules`，或容器啟動時安裝。
- [Risk] `db:push` 對既有資料可能造成破壞性變更 → Mitigation：MVP 為全新 DB，無既有資料風險；`example` 表可保留或移除。
- [Risk] Node 版本不一致（本機曾為 18）→ Mitigation：已新增 `.node-version=22.22.2`，容器 base image 亦用 Node 22。

## Migration Plan

全新功能，無資料遷移。部署／啟動步驟：
1. 本機以 fnm 套用 `.node-version`（Node 22.22.2），`pnpm install`。
2. `docker compose up`：啟動 `db`（Postgres 16）與 `server`（dev 容器，啟動先 `db:push` 建 `users`/`todos` 表再 `tsx watch`）。
3. 本機 `pnpm dev:web` 啟前端，連 `http://localhost:7529`。
4. Rollback：`docker compose down`；因無既有資料，移除 volume 即回到乾淨狀態。

## Open Questions

- ~~是否要保留 `packages/db` 的 `example` 表？~~ 已解決：移除 `example.ts` 並從 `schema/index.ts` 移除匯出，DB 表亦已 db:push 移除。
- 是否需要一組預設 seed 帳號方便測試？（目前有 register 端點，可不需要）
