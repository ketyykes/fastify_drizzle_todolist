# fastify_drizzle_todolist

本專案以 [Better Fullstack](https://github.com/Marve10s/Better-Fullstack) 建立，是結合 React、Vite SPA、Fastify 等技術的現代 TypeScript 全端範本。

## 特色功能

- **TypeScript** - 型別安全與更好的開發體驗
- **React + Vite** - 由 Vite 驅動、client-side routing 的 React SPA
- **TailwindCSS** - CSS 框架
- **shadcn/ui** - UI 元件庫
- **Fastify** - 高效能、低負擔的 web 框架
- **JWT auth** - 註冊／登入／登出，以 Bearer token 驗證（`@fastify/jwt` + `bcryptjs`）
- **jotai + zod** - 前端狀態管理與 schema 驗證
- **Node.js** - 執行環境
- **Drizzle** - TypeScript-first ORM
- **PostgreSQL** - 資料庫
- **Transactional Outbox** - todo 完成事件透過 outbox sweeper worker 可靠送達 mock 外部 webhook（設計文件：`docs/outbox/design.md`，教學頁：`/outbox-guide`）
- **Staging Sync** - 大量外部資料以「暫存表＋單一交易原子切換」做全量同步，封頂記憶體同時保住原子性（設計文件：`docs/staging-sync/design.md`；含維運端點、CLI、前端教學頁，詳見下方「Staging Sync 快速體驗」）

## 快速開始

這套設定讓**後端＋資料庫跑在 Docker**，**前端跑在本機** Vite，並連到後端在 host 端暴露的埠。

### 前置需求

- **Node.js 22** — 必要版本（Vitest 4／rolldown 需要 `node:util.styleText`）。
  專案已附 `.node-version`，用 `fnm` 的話直接 `fnm use` 即可。
- **Docker**（跑後端 + PostgreSQL 容器）。
- **pnpm**（`corepack enable`）。

### 1. 安裝依賴

```bash
fnm use            # 切到 Node 22（依照 .node-version）
pnpm install
```

### 2. 設定環境變數

複製範本檔並填入實際值。用 `openssl rand -hex 32` 產生 JWT 密鑰、
`openssl rand -hex 16` 產生 DB 密碼。

```bash
cp .env.example .env                          # JWT_SECRET、POSTGRES_PASSWORD（docker compose 用）
cp apps/web/.env.example apps/web/.env         # VITE_SERVER_URL=http://localhost:7529
cp apps/server/.env.example apps/server/.env   # 本機端 db:push／測試／dev:server 用
```

注意事項：

- 根目錄 `.env` 的 `POSTGRES_PASSWORD` 與 `apps/server/.env` 內
  `DATABASE_URL` 的密碼**必須一致**。
- `apps/server/.env` 用 `localhost:5432`（host 端連線）；Docker 容器內則用
  根目錄 `.env` 提供的值連 `db:5432`——這兩個檔案不用手動對齊。
- 根目錄 `.env` 也設定了 outbox sweeper 的參數：`OUTBOX_WEBHOOK_URL`、
  `OUTBOX_SWEEP_INTERVAL_MS`、`OUTBOX_SEND_TIMEOUT_MS`（詳見 `docs/outbox/design.md`）。
- `.env` 檔案已被 gitignore；只有 `.env.example` 範本會進版控。

### 3. 執行

```bash
docker compose up -d     # 後端 (:7529) + outbox worker + PostgreSQL；啟動時會跑 db:push
pnpm dev:web             # 前端（Vite, :5173）
```

- 網頁：[http://localhost:5173](http://localhost:5173)
- API：[http://localhost:7529](http://localhost:7529)（用冷門埠避免衝突）
- Outbox 教學頁：[http://localhost:5173/outbox-guide](http://localhost:5173/outbox-guide)
  （架構圖、狀態機、即時演示）

`docker compose up -d` 同時也會啟動 `worker` 服務，它會輪詢 outbox 資料表
（間隔為 `OUTBOX_SWEEP_INTERVAL_MS`），並把待送出的訊息送往 mock webhook
（`/mock-external/notifications`）。

以 `docker compose down` 停止（加上 `-v` 可一併清除資料庫 volume——
每次變更 `POSTGRES_PASSWORD` 時都需要這麼做）。

### Staging Sync 快速體驗

一次全量刷新一份大量、巢狀的外部資料時，「全部載入記憶體」會 OOM、「天真分批 commit」會讓使用
者看到「資料被刪掉一半」的假象——這裡示範「staging 暫存表＋單一交易原子切換」如何同時封頂記憶
體又保住原子性。設計細節見 `docs/staging-sync/design.md`。

體驗流程：

1. `docker compose up -d` 啟動後端＋PostgreSQL（沿用同一組服務）。
2. 用種子帳號登入取得 JWT：`POST /auth/login`（帳密見上方「設定環境變數」段落）。
3. 觸發一次同步：`POST /staging-sync/trigger`（帶 `Authorization` header），或用 CLI
   `pnpm --filter server staging-sync:run`。
4. 觀察執行紀錄：`GET /staging-sync/runs`；查看目前生效的範本目錄：`GET /staging-sync/catalog`。
5. 想示範不同故障情境，可先用 `PUT /mock-source/mode`（body `{ "mode": "fail_page_2" }` 等）
   切換 mock 來源的行為模式，再觸發同步觀察 `fetch_failed`／重播行為。
6. 前端教學頁：[http://localhost:5173/staging-sync-guide](http://localhost:5173/staging-sync-guide)
   （架構圖、狀態機圖、關鍵設計說明、即時演示區，含觸發同步／切換 mock 模式／放棄 staged 執行）。

## 專案結構

```
fastify_drizzle_todolist/
├── apps/
│   ├── web/         # 前端應用（React + Vite SPA）
│   │   └── src/routes/   # outbox-guide.tsx、staging-sync-guide.tsx（教學頁）
│   └── server/      # 後端 API（Fastify）
│       └── src/
│           ├── routes/    # auth.ts、todos.ts、mock-external.ts、outbox-admin.ts、
│           │               mock-source.ts、staging-sync-admin.ts
│           ├── outbox/    # outbox 核心模組：repository、sweeper、sweep-loop、sender、backoff、config
│           ├── staging-sync/  # staging-sync 核心模組（詳見 docs/staging-sync/design.md）
│           ├── scripts/   # outbox-requeue-dead.ts、outbox-prune.ts、
│           │               staging-sync-run/status/abandon/prune.ts（維運用 CLI 腳本）
│           └── worker.ts  # 獨立的 outbox sweeper worker 進入點
├── packages/
│   ├── db/          # Drizzle schema（users、todos、outbox_messages、sync_runs、template-catalog……）+ client
│   ├── env/         # 前後端共用的型別安全 env（t3-env）
│   └── config/      # 共用的 TypeScript 設定
├── docs/
│   ├── outbox/design.md         # transactional outbox 設計文件
│   └── staging-sync/design.md   # staging-sync 設計文件
├── docker-compose.yml   # 後端 + worker（dev 容器）+ PostgreSQL
└── .env.example         # env 範本（根目錄／apps/web／apps/server）
```

## 常用指令

- `pnpm run dev`：以開發模式啟動所有應用
- `pnpm run build`：建置所有應用
- `pnpm run dev:web`：只啟動前端
- `pnpm run dev:server`：只啟動後端（本機，非 Docker）
- `pnpm run check-types`：檢查所有應用的 TypeScript 型別
- `pnpm run test`：跑測試（web + server；server 測試打的是真的 Postgres，
  但已隔離到獨立的 `_test` 資料庫，不會清空開發資料——詳見 CLAUDE.md）
- `pnpm run db:push`：把 schema 變更推到開發資料庫
- `pnpm run db:push:test`：把 schema 變更推到隔離的測試資料庫
- `pnpm run db:studio`：開啟資料庫視覺化管理介面

Outbox 相關指令（`--filter server`）：

- `pnpm --filter server worker`：獨立啟動 outbox sweeper worker
  （每隔 `OUTBOX_SWEEP_INTERVAL_MS` 輪詢一次）
- `pnpm --filter server outbox:requeue-dead [--id=1,2]`：把 dead 狀態的
  outbox 訊息重新排回 pending
- `pnpm --filter server outbox:prune [--days=30]`：清除超過保留天數、
  狀態為 done 的 outbox 訊息
