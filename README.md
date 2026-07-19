# fastify_drizzle_todolist

This project was created with [Better Fullstack](https://github.com/Marve10s/Better-Fullstack), a modern TypeScript stack that combines React, Vite SPA, Fastify, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **React + Vite** - Client-routed React SPA powered by Vite
- **TailwindCSS** - CSS framework
- **shadcn/ui** - UI components
- **Fastify** - Fast, low-overhead web framework
- **JWT auth** - Register / login / logout with Bearer tokens (`@fastify/jwt` + `bcryptjs`)
- **jotai + zod** - Client state and schema validation
- **Node.js** - Runtime environment
- **Drizzle** - TypeScript-first ORM
- **PostgreSQL** - Database engine

## Getting Started

This setup runs the **backend + database in Docker** while the **frontend runs
locally** with Vite and connects to the backend's host port.

### Prerequisites

- **Node.js 22** — required (Vitest 4 / rolldown need `node:util.styleText`).
  A `.node-version` file is included; with `fnm` just run `fnm use`.
- **Docker** (for the backend + PostgreSQL containers).
- **pnpm** (`corepack enable`).

### 1. Install dependencies

```bash
fnm use            # switch to Node 22 (per .node-version)
pnpm install
```

### 2. Set up environment variables

Copy the example files and fill in the values. Generate secrets with
`openssl rand -hex 32` (JWT) and `openssl rand -hex 16` (DB password).

```bash
cp .env.example .env                          # JWT_SECRET, POSTGRES_PASSWORD (used by docker compose)
cp apps/web/.env.example apps/web/.env         # VITE_SERVER_URL=http://localhost:7529
cp apps/server/.env.example apps/server/.env   # host-side db:push / tests / dev:server
```

Notes:

- The `POSTGRES_PASSWORD` in the root `.env` and the password inside
  `apps/server/.env`'s `DATABASE_URL` **must match**.
- `apps/server/.env` uses `localhost:5432` (host side); the Docker container
  uses `db:5432` via values from the root `.env` — you don't edit those.
- `.env` files are gitignored; only the `.env.example` templates are committed.

### 3. Run

```bash
docker compose up -d     # backend (:7529) + PostgreSQL; runs db:push on startup
pnpm dev:web             # frontend (Vite, :5173)
```

- Web app: [http://localhost:5173](http://localhost:5173)
- API: [http://localhost:7529](http://localhost:7529) (uncommon port to avoid clashes)

Stop with `docker compose down` (add `-v` to also wipe the database volume —
required whenever you change `POSTGRES_PASSWORD`).

## Project Structure

```
fastify_drizzle_todolist/
├── apps/
│   ├── web/         # Frontend application (React + Vite SPA)
│   └── server/      # Backend API (Fastify): routes/auth.ts, routes/todos.ts
├── packages/
│   ├── db/          # Drizzle schema (users, todos) + client
│   ├── env/         # Type-safe env (t3-env) for web & server
│   └── config/      # Shared TypeScript config
├── docker-compose.yml   # backend (dev container) + PostgreSQL
└── .env.example         # env templates (root / apps/web / apps/server)
```

## Available Scripts

- `pnpm run dev`: Start all applications in development mode
- `pnpm run build`: Build all applications
- `pnpm run dev:web`: Start only the web application
- `pnpm run dev:server`: Start only the server
- `pnpm run dev:server`: Start only the server (local, non-Docker)
- `pnpm run check-types`: Check TypeScript types across all apps
- `pnpm run test`: Run the test suite (web + server; server tests need PostgreSQL)
- `pnpm run db:push`: Push schema changes to database
- `pnpm run db:studio`: Open database studio UI
