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

## Common Commands

- `pnpm install` - Install dependencies
- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm test` - Run tests
- `pnpm db:push` - Push database schema
- `pnpm db:studio` - Open database UI

## Maintenance

Keep AGENTS.md updated when:

- Adding/removing dependencies
- Changing project structure
- Adding new features or services
- Modifying build/dev workflows

AI assistants should suggest updates to this file when they notice relevant changes.
