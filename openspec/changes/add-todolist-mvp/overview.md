# Overview: add-todolist-mvp

<!--
  ASCII 人類版摘要。所有圖包在三引號程式碼區塊內。
  框內盡量用英文標籤以維持等寬對齊；中文註解放框外，用 ← 對齊。
-->

## Scope

把目前的 scaffold 空殼補成一個能跑完整流程的最小 TODOLIST：使用者可註冊、登入、
管理「只屬於自己」的待辦，並登出。認證用 JWT + Bearer token。後端與 Postgres 以
Docker 啟動，前端本機 `vite dev` 連到後端的 host 映射埠。

**Size**: large — 任務 >20 條（約 50 個 checkbox），橫跨 web / server / db / env / docker
五處，雖然只有 2 個 capability。
**Frontend involved**: yes — specs 含登入/註冊/todos 的 UI 與登出互動（移除 token、導向登入頁）。

---

## What Changes

- 新增 `user-auth`：`POST /auth/register`、`POST /auth/login`、`GET /auth/me`、前端登出。
- 新增 `todo-management`：`GET/POST/PATCH/DELETE /todos`，以 `user_id` 隔離。
- 資料層新增 `users`、`todos` 兩張 Drizzle schema。
- 後端加 `@fastify/jwt` + `bcryptjs`；env 加 `JWT_SECRET`；`index.ts` 改讀 `env.PORT`。
- `docker-compose.yml` 改 dev 容器（server tsx watch、啟動先 `db:push`）；前端本機跑。

目前狀態與變更後的對照：

```
=== Before ===
web    : 一頁 ASCII 大字，router 只有 "/"
server : GET "/" 回 "OK"
db     : 只有無用的 example 表
auth   : 無

=== After ===
web    : /login /register /todos，受保護路由，header 有登出鈕
server : /auth/* 與 /todos/*，authenticate preHandler 驗 Bearer
db     : users、todos 兩張表（todos.user_id → users.id）
auth   : JWT 簽發 + Bearer 驗證，token 存前端 localStorage
```

---

## UI Mockups

三個主要畫面（login / register / todos）與關鍵互動（登入失敗、新增、打勾、登出）。

```
=== State 1: 未登入，進入 /login (before) ===

┌────────────────────────────────────────┐
│  Todo App                     [Theme]   │
├────────────────────────────────────────┤
│                                          │
│              Sign in                     │
│                                          │
│   Email                                  │
│   [____________________________]         │
│                                          │
│   Password                               │
│   [____________________________]         │
│                                          │
│   [          Sign in          ]          │
│                                          │
│   No account? [Register]                 │ ← 連到 State 2
└────────────────────────────────────────┘
              │
              │ 送出錯誤帳密 → 後端回 401
              ▼

=== State 2: 登入失敗 (error) ===

┌────────────────────────────────────────┐
│              Sign in                     │
│                                          │
│   Email     [alice@example.com]          │
│   Password  [••••••••]                    │
│                                          │
│   ! Invalid email or password            │ ← sonner toast + 欄位錯誤
│                                          │
│   [          Sign in          ]          │
└────────────────────────────────────────┘


=== State 3: 註冊頁 /register ===

┌────────────────────────────────────────┐
│              Create account              │
│                                          │
│   Email                                  │
│   [____________________________]         │
│   Password  (min 8 chars)                │
│   [____________________________]         │
│                                          │
│   [         Create account         ]     │
│                                          │
│   Have an account? [Sign in]             │
└────────────────────────────────────────┘
              │
              │ 註冊/登入成功 → 存 token → 導向 /todos
              ▼

=== State 4: 登入後 /todos，尚無資料 (empty) ===

┌────────────────────────────────────────┐
│  Todo App              alice  [Logout]  │ ← header 出現登出鈕
├────────────────────────────────────────┤
│                                          │
│   [ Add a new task...        ] [ Add ]   │
│                                          │
│        No tasks yet. Add one above.      │
└────────────────────────────────────────┘
              │
              │ 輸入 "Buy milk" → 按 [Add] → POST /todos
              ▼

=== State 5: 有資料，含打勾與刪除 ===

┌────────────────────────────────────────┐
│  Todo App              alice  [Logout]  │
├────────────────────────────────────────┤
│                                          │
│   [ Add a new task...        ] [ Add ]   │
│                                          │
│   [x] Read a book                  [Del] │ ← 已完成，checkbox 打勾
│   [ ] Buy milk                     [Del] │ ← 未完成
│   [ ] Ship the MVP                 [Del] │
└────────────────────────────────────────┘
              │
              │ 點 [Logout] → 清 localStorage → 導回 /login
              ▼

=== State 6: 登出後回到 State 1 ===

（回到 /login，後續請求不再帶 Authorization 標頭）
```

---

## Architecture

前端在瀏覽器/本機，後端與 DB 在 Docker；瀏覽器透過 host 映射埠 3001 連後端，
每次請求由 axios interceptor 附上 Bearer token，後端以 preHandler 驗證後才進 route。

```
Host (你的機器)
┌──────────────────────────────────────────────────────────────┐
│  Browser  ──►  Vite dev (localhost:5173)                       │
│                 │  jotai atom + localStorage 存 token          │
│                 │  axios interceptor: Authorization: Bearer    │
│                 ▼                                               │
│           http://localhost:3001                                │
│  ── Docker network ──────────────────────────────────────────┐ │
│  │                                                            │ │
│  │  server 容器 (Fastify, 3000)                               │ │
│  │  ┌──────────────┐   ┌──────────────┐   ┌───────────────┐  │ │
│  │  │ authenticate │──►│ auth routes  │   │ todos routes  │  │ │
│  │  │ preHandler   │   │ /auth/*      │   │ /todos/* (■)  │  │ │
│  │  │ jwtVerify    │   │ bcrypt+jwt   │   │ where user_id │  │ │
│  │  └──────────────┘   └──────┬───────┘   └───────┬───────┘  │ │
│  │                            │  Drizzle ORM      │          │ │
│  │                            ▼                   ▼          │ │
│  │                     ┌────────────────────────────────┐   │ │
│  │                     │  db 容器 (Postgres 16)          │   │ │
│  │                     │  users  ◄──user_id──  todos     │   │ │
│  │                     └────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
  ■ = 需 Bearer token
```

---

## Task Tree

任務依賴：後端由 §0 基礎建設起，§1→§2→§3 逐層堆疊；前端 §4/§5 依賴登入授權；
容器設定 §6 依賴後端完成。

```
0. 前置基礎建設 (非 TDD)
├── 0.1 Node 22.22.2 + pnpm install
├── 0.2 裝 @fastify/jwt / bcryptjs
├── 0.3 env 加 JWT_SECRET
├── 0.4 整合測試基礎 buildApp() + inject
└── 0.5 index.ts 改讀 env.PORT

1. 註冊 (user-auth)            depends on §0
├── 1.1/1.2  RED/GREEN register 成功 (建 users schema + jwt plugin)
├── 1.3/1.4  RED/GREEN bcrypt 雜湊非明文
├── 1.5/1.6  RED/GREEN 重複 email → 409
└── 1.7/1.8  RED/GREEN 輸入不合法 → 400

2. 登入與授權 (user-auth)      depends on §1
├── 2.1/2.2   RED/GREEN login 回 token
├── 2.3/2.4   RED/GREEN 錯帳密 → 一致 401
├── 2.5/2.6   RED/GREEN authenticate preHandler
├── 2.7/2.8   RED/GREEN 無效 token → 401
└── 2.9-2.12  RED/GREEN GET /auth/me

3. Todos CRUD 與隔離 (todo-management)   depends on §2
├── 3.1/3.2    RED/GREEN 建立 (建 todos schema)
├── 3.3/3.4    RED/GREEN 空 title → 400
├── 3.5/3.6    RED/GREEN list 只回自己的
├── 3.7-3.10   RED/GREEN PATCH 完成/404
├── 3.11/3.12  RED/GREEN DELETE
└── 3.13-3.18  RED/GREEN 跨使用者隔離 → 404

4. 前端認證接線 (web)          depends on §2
└── 4.1/4.2  RED/GREEN logout + interceptor (Bearer/401)

5. 前端頁面與路由 (UI，非 TDD)  depends on §4
├── 5.1 login 頁   5.2 register 頁   5.3 todos 頁
└── 5.4 受保護路由 + 登出鈕   5.5 VITE_SERVER_URL

6. 容器與設定 (非 TDD)         depends on §3
├── 6.1 docker-compose 改 dev 容器
└── 6.2 手動端到端驗證
```

---

## Cross-Cutting Impact

| File / module | Change kind | Risk |
|---------------|-------------|------|
| `packages/db/src/schema/users.ts` | new | low |
| `packages/db/src/schema/todos.ts` | new | low |
| `packages/db/src/schema/index.ts` | modify | low |
| `packages/env/src/server.ts` | modify（加 JWT_SECRET） | low |
| `apps/server/src/index.ts` | modify（buildApp + env.PORT + jwt plugin） | medium |
| `apps/server/src/routes/auth.ts` | new | medium |
| `apps/server/src/routes/todos.ts` | new | medium |
| `apps/server/package.json` | modify（+@fastify/jwt, bcryptjs） | low |
| `apps/web/src/lib/http-client.ts` | modify（interceptor） | medium |
| `apps/web/src/lib/auth.ts` | new（jotai + localStorage） | medium |
| `apps/web/src/routes/{login,register,todos}.tsx` | new | medium |
| `apps/web/src/router.tsx` | modify（受保護路由） | medium |
| `apps/web/src/components/header.tsx` | modify（登出鈕） | low |
| `docker-compose.yml` | modify（dev 容器、db:push） | high |
| `.node-version` | new（22.22.2） | low |
