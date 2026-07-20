# fastify_drizzle_todolist

This file provides context about the project for AI assistants.

## Project Overview

- **Ecosystem**: Typescript

## Tech Stack

- **Runtime**: node
- **Package Manager**: pnpm

### Frontend

- Framework: react-vite
- CSS: tailwind
- UI Library: shadcn-ui
- State: jotai

### Backend

- Framework: fastify
- Validation: zod

### Database

- Database: postgres
- ORM: drizzle

### Additional Features

- Testing: vitest

## Project Structure

```
fastify_drizzle_todolist/
├── apps/
│   ├── web/         # Frontend application
│   └── server/      # Backend API
├── packages/
│   └── db/          # Database schema
```

## Transactional Outbox 教學範例

todo 完成事件透過 transactional outbox 模式可靠推送到 mock 外部 webhook 服務。
設計規格見 `docs/outbox/design.md`；核心模組在 `apps/server/src/outbox/`；
獨立 worker 進入點 `apps/server/src/worker.ts`（docker-compose 有對應 `worker` 服務）；
前端教學頁 `/outbox-guide`（架構圖＋狀態機＋即時演示）。

相關指令（`--filter server`）：

- `pnpm --filter server worker` - 啟動 outbox sweeper worker（輪詢間隔 `OUTBOX_SWEEP_INTERVAL_MS`）
- `pnpm --filter server outbox:requeue-dead [--id=1,2]` - 把 dead 訊息重排回 pending
- `pnpm --filter server outbox:prune [--days=30]` - 清理保留天數外的 done 訊息
- `pnpm db:seed` - 建立固定的本機開發測試帳號（email/password 已存在則略過，不會覆寫密碼）；
  帳密可用 `SEED_USER_EMAIL` / `SEED_USER_PASSWORD` 覆寫，未提供時預設
  `dev@example.com` / `dev12345`（僅供本機測試，正式環境務必覆寫或移除）；
  docker-compose 的 `server` service 會在 `pnpm db:push` 之後自動執行

## 測試資料庫隔離

後端整合測試打真的 Postgres，且 `resetDb()` 會 TRUNCATE `todos`／`users`／`outbox_messages`。
為避免清空開發庫，測試一律連到**獨立測試庫**：`apps/server/src/test/setup.ts` 會把
`DATABASE_URL` 的資料庫名自動換成 `<name>_test`（即 `fastify_drizzle_todolist_test`），
可用 `TEST_DATABASE_URL` 覆寫。兩道防呆確保安全（**請勿移除**）：setup 檢查測試庫名須以
`_test` 結尾、`resetDb()` TRUNCATE 前再向 `current_database()` 確認一次，否則中止。

- 首次或 schema 變更後：`pnpm db:push:test`（推 schema 到測試庫；等同 `DRIZZLE_TEST=1 drizzle-kit push`）
- 測試庫需先存在：`CREATE DATABASE fastify_drizzle_todolist_test;`

## Common Commands

- `pnpm install` - Install dependencies
- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm test` - Run tests（跑在獨立測試庫，不會清空開發庫）
- `pnpm db:push` - Push database schema
- `pnpm db:push:test` - Push schema to the test database
- `pnpm db:studio` - Open database UI

## Maintenance

Keep CLAUDE.md updated when:

- Adding/removing dependencies
- Changing project structure
- Adding new features or services
- Modifying build/dev workflows

AI assistants should suggest updates to this file when they notice relevant changes.
