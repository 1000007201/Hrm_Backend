# CLAUDE.md — HRM Portal (Backend)

Project memory for Claude Code. Read this before making changes.

## What this is

Backend API for a **multi-tenant HRM SaaS** aimed at Indian SMEs. Each client
company is a tenant. The product handles employee records, attendance, leave,
salary structure, payroll (with Indian statutory compliance — PF/ESI/PT/TDS),
and an employee self-service portal.

- **Solo developer.** Backend-strong, comfortable with raw SQL, learning Prisma.
- **Frontend is a SEPARATE repo** (React + Vite + TS + Tailwind). This repo is
  API-only. Do not add frontend code here.
- Current phase: **Stage 0 — foundation** (identity, multi-tenancy, DB, server
  skeleton). Do not scaffold Stage 1+ features unless explicitly asked.

## Frontend repo

Lives at **`e:\Nishant\HRM_Frontend`** — a sibling directory to this repo
(`e:\Nishant\HRM_Backend`), not a subfolder, and its own git repo with its own
`CLAUDE.md`. Read that file directly if a task needs frontend-side context
beyond this summary.

- Stack: React + Vite + TypeScript, Tailwind, TanStack Query (server state),
  React Hook Form + zod (forms), Better Auth React client (`better-auth/react`)
  for `/api/auth/*`. Runs on `localhost:5173`; talks to this API via
  `VITE_API_URL` (this API defaults to `localhost:4000`), cookie/session based
  (`credentials: include`).
- Structure (under `src/`):
  - `lib/apiClient.ts` — `apiFetch<T>()` fetch wrapper + `ApiError`, the one
    chokepoint for every non-Better-Auth API call.
  - `lib/auth-client.ts` — Better Auth React client, `API_BASE_URL`.
  - `lib/useActiveMemberRole.ts` — reads the caller's role in the active org.
  - `components/auth/` — `AuthLayout`, `Button`, `FormInput`, `FormSelect`,
    `RequireAuth`, `RequireGuest`.
  - `components/layout/` — `AppLayout`.
  - `features/employees/` — `api.ts`, `hooks.ts`, `types.ts`, `validation.ts`,
    `EmployeeForm.tsx`. Only feature slice so far; future stages (attendance,
    leave, payroll) get their own `features/<domain>/` folder.
  - `pages/auth/` — SignIn, ForgotPassword, ResetPassword, RegisterCompany,
    AcceptInvitation.
  - `pages/employees/` — List, Detail, Create, Edit, PendingInvitations.
  - `pages/DashboardPage.tsx`.

**Known drift (as of 2026-08-06):** `lib/apiClient.ts`'s `apiFetch` still
expects the *old* unwrapped response shape — `return body as TResponse` on
success, error message read off `body.error` as a plain string. This backend
now wraps every route except `/api/auth/*` in an envelope (see this repo's
README.md, "API response envelope" section):
`{ success: true, data }` / `{ success: false, error: { code, message,
details? } }`. `apiFetch` and each `features/*/api.ts` caller need updating to
unwrap `.data` and read `.error.message` / `.error.code` — until that lands,
every non-auth API call in the frontend is broken.

## Tech stack (decided — do not substitute)

- Node.js + **TypeScript**, ESM (`"type": "module"`, NodeNext resolution)
- **Fastify v5** (not Express)
- **PostgreSQL** + **Prisma ORM**
- **Better Auth** (self-hosted) — Prisma adapter + organization plugin
- **zod** for validation

Better Auth was chosen over Clerk to avoid vendor lock-in and pricing risk.
We own session security in exchange.

## Commands

```bash
npm run dev          # tsx watch — dev server with hot reload
npm run build        # tsc -> dist/
npm run start        # run built server
npm run typecheck    # tsc --noEmit  (must pass before considering work done)
npm run db:generate  # prisma generate
npm run db:migrate   # prisma migrate dev
npm run db:studio    # prisma studio
npm run auth:generate # regenerate Better Auth models into the schema
```

Run Prisma directly with **`npx prisma ...`** (it's a local dep, not global —
bare `prisma` will fail in the shell).

## Architecture

```
src/
  index.ts          boot: validate env, build app, listen
  server.ts         app factory: register cors, plugins, routes
  env.ts            zod env validation — fails fast at boot
  lib/prisma.ts     PrismaClient singleton (globalThis-cached in dev)
  lib/auth.ts       Better Auth config
  plugins/auth.ts   mounts /api/auth/*, adds request.getSession()
  routes/           feature routes (health.ts for now)
prisma/
  schema.prisma
  migrations/       committed to git — never delete
```

## The auth model — internalize this

Two layers live in **one Postgres database**:

- **Better Auth owns identity + tenancy**: User, Session, Account, Verification,
  Organization, Member, Invitation. One `Organization` == one client company.
- **We own the domain**: `Employee` and everything HR-specific.

They link via `Employee.userId -> User.id` and `Employee.organizationId ->
Organization.id`. Do NOT put HR/domain fields on Better Auth's models; add them
to `Employee`. Do NOT hand-edit fields the Better Auth CLI owns — regenerate via
`npm run auth:generate`.

`Employee` has a self-relation for the reporting hierarchy
(`managerId` -> `manager` / `reports`), nullable at the top of the chain, plus a
`role` enum (ADMIN/HR/MANAGER/EMPLOYEE).

## Conventions

- **ESM imports need explicit `.js` extensions** in relative imports (e.g.
  `import { auth } from "./lib/auth.js"`), even though the source is `.ts`. This
  is required by NodeNext. Don't drop the extension.
- **ORM-first, raw-SQL when it fights you.** Use Prisma for CRUD and normal
  queries. Drop to `prisma.$queryRaw` (parameterized) for heavy payroll
  aggregations and compliance reports where the ORM is awkward or slow.
- **Watch for N+1.** Never query inside a loop — use `include`/`select` to fetch
  relations in one go. If you catch yourself looping `findUnique`, that's the
  smell.
- **Validate all external input with zod** before it touches the DB. Payroll and
  salary inputs especially — a type bug here is a money bug.
- **Every mutation must be tenant-scoped.** Filter by `organizationId` from the
  session. A user must never read or write another company's data. Treat missing
  tenant scoping as a bug.
- Prefer small, focused route files under `src/routes/`, registered in
  `server.ts`.

## Coding standards

Naming:
- **Variables & functions: camelCase.** Start lowercase, capitalize each
  following word — `employeeCount`, `calculatePayroll`, `getEmployeeById`.
- **Types, interfaces, enums, Prisma models: PascalCase** — `Employee`,
  `LeaveRequest`, `EmployeeRole`.
- **Constants (fixed config values): UPPER_SNAKE_CASE** — `MAX_LEAVE_DAYS`,
  `PF_RATE`.
- Booleans read as yes/no questions: `isActive`, `hasApproval`, `canEdit`.

Names must be **relevant and descriptive** — the name says what the thing is or
does. No single letters (except loop indices `i`/`j`), no vague names like
`data`, `temp`, `val`, `info`, `handleStuff`. Prefer clarity over brevity:
`pendingLeaveRequests`, not `plr` or `list`.

## Database / migrations rules

- **Always commit `prisma/migrations/` (with the `.sql` files) to git**, in the
  same commit as the schema change. Out-of-sync schema and migrations = drift.
- Postgres lowercases unquoted identifiers. Prisma table names are capitalized,
  so hand-written SQL must quote them: `SELECT * FROM "Employee"`.
- Never commit `.env`. Never commit the generated Prisma client
  (`src/generated/`). Both belong in `.gitignore`.
- In dev, if migrations drift, `npx prisma migrate reset` is fine (no real data
  yet). Never run reset against anything with real data.

## Before you call a task done

1. `npm run typecheck` passes (no errors).
2. `npx prisma validate` passes if the schema changed.
3. New env vars are added to `env.ts` (zod) AND `.env.example`.
4. New migrations are created and staged for commit.

## Don'ts

- Don't switch frameworks/libraries away from the stack above.
- Don't add features beyond the current stage without being asked.
- Don't hand-roll auth logic that Better Auth already provides.
- Don't weaken tenant isolation for convenience.
- Better Auth's API moves fast — if unsure of its current API, check
  better-auth.com rather than guessing from memory.
