# HRM_Backend

Backend foundation for a multi-tenant HRM SaaS (Indian SMEs). Built on Fastify 5, TypeScript (ESM/NodeNext), Prisma 7 + PostgreSQL, and Better Auth (self-hosted) with its Prisma adapter and organization plugin for multi-tenancy.

**Stage 0 scope:** identity/tenancy foundation — auth, organizations, and `Employee` records (HR-first: an `Employee` can exist with no linked login, see "Data model" below).

## Requirements

- Node.js >= 20 (developed on 24)
- A running PostgreSQL instance

## Bringing it up

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and a real BETTER_AUTH_SECRET
npm run db:migrate            # creates all tables (auth, organization, Employee)
npm run dev
```

The API listens on `http://localhost:4000` by default.

If you ever change `src/core/auth.ts` (e.g. add a plugin), regenerate the Better Auth Prisma models before migrating:

```bash
npm run auth:generate
npm run db:migrate
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch-mode dev server via tsx (`src/index.ts`) |
| `npm run build` | `prisma generate` + TypeScript compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type check without emitting |
| `npm run db:migrate` | Create + apply a migration (dev) |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:seed` | Create a demo company + ADMIN via `prisma/seed.ts` (safe to re-run) |
| `npm run auth:generate` | Regenerate Better Auth's Prisma models into `prisma/schema.prisma` |
| `npm test` | Runs `*.test.ts` files via Node's built-in test runner (`node --test`, no framework) |

## Environment

All variables are validated at startup by [src/env.ts](src/env.ts); the process exits with a readable error if any are missing or malformed.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `4000` | |
| `DATABASE_URL` | — | Required PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | — | Required, min 32 chars. Generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | — | Required, this API's own base URL |
| `FRONTEND_ORIGIN` | — | Required, the single trusted frontend origin (used for CORS + Better Auth's `trustedOrigins`) |
| `RESEND_API_KEY` | unset | [Resend](https://resend.com) API key. Unset in dev → emails are logged to the console instead of sent (see below) |
| `EMAIL_FROM` | `onboarding@resend.dev` | "From" address for outgoing email |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Gates sign-in on a verified email. See "Turning on email verification" below |
| `ENABLE_PUBLIC_SIGNUP` | `false` | Opens `POST /api/register-company` to the public. While `false`, callers must send `REGISTRATION_SECRET` as an `X-Registration-Secret` header |
| `REGISTRATION_SECRET` | unset | Shared secret gating company registration (min 16 chars). Generate with `openssl rand -base64 32`. Irrelevant once `ENABLE_PUBLIC_SIGNUP=true` |
| `ACCRUAL_SECRET` | — | Required, min 16 chars. Shared secret gating `POST /system/leave/accrual/run-all` (sent as `X-Accrual-Secret`) — see "Leave: types, balances & accrual" below |
| `ATTENDANCE_HALF_DAY_THRESHOLD_MINUTES` | `240` | Worked minutes below this on a day with attendance count as `HALF_DAY` instead of `PRESENT` — see "Attendance" below |

## Layout

**Feature-first.** Cross-cutting infrastructure lives in `core/`, domain
primitives shared by more than one feature in `shared/`, and each feature owns
one folder under `modules/` containing its routes, its business operations,
and its tests. Adding a feature means adding a folder, not touching five.

Inside a module the split is consistent:

- **`*.routes.ts`** — HTTP only: parse with zod, authorize via the guard, call
  one service function, wrap the result in `ok(...)`.
- **`*.service.ts`** — the business operations, taking `(prisma, params)`.
  Every transaction and multi-step rule lives here, so it is testable without
  HTTP and reusable from a cron or a script.
- **everything else** — pure domain logic (`derivation.ts`, `orgChart.ts`,
  `accrual.ts`, …) plus its colocated `*.test.ts`.

```
prisma/schema.prisma          Better Auth models (generated) + org plugin models + domain models (hand-authored)
prisma/seed.ts                Demo company + ADMIN via registerCompany(), idempotent
prisma.config.ts              Prisma 7 CLI config (migration datasource)

src/index.ts                  Boots: validates env, builds the app, listens, handles graceful shutdown
src/server.ts                 Composition root: builds Fastify, registers cors -> plugins -> error handler -> modules
src/env.ts                    Zod-validated environment, fails fast at boot

src/core/                     Cross-cutting infrastructure, no feature knowledge
  prisma.ts                   PrismaClient singleton (globalThis-cached in dev) + pg driver adapter
  auth.ts                     Better Auth config: Prisma adapter, organization + openAPI plugins
  email.ts                    sendEmail() — Resend, console fallback in dev
  errors.ts                   AppError (statusCode/code/message/details) thrown for known failures
  response.ts                 ok(data) — the { success: true, data } envelope
  plugins/auth.ts             Mounts Better Auth at /api/auth/*, decorates request.getSession()
  plugins/authGuard.ts        app.requireAuth / app.requireRole([...]); populate request.auth
  plugins/errorHandler.ts     Central setErrorHandler — AppError/zod/Prisma -> { success: false, error }

src/shared/                   Domain primitives used by MORE THAN ONE module
  workingDays.ts              countWorkingDays() — the ONE place weekend + holiday day-counting lives

src/modules/
  health/health.routes.ts     GET /health, GET /health/db, GET /me
  identity/
    registerCompany.ts        Tenant bootstrap: User -> Organization -> owner Member -> ADMIN Employee -> active org
    registerCompany.routes.ts POST /api/register-company
    invitations.ts            EmployeeRole <-> org role mapping, accept-URL builder, link-on-accept logic
    invitations.routes.ts     Invite/accept-link/list/cancel (ADMIN/HR only)
  employees/
    orgChart.ts               buildOrgChartTree() — reporting forest in memory, handles orphans/cycles
    employees.routes.ts       Employee CRUD + org chart
  leave/
    leaveTypes.ts             ensureDefaultLeaveTypes() — idempotent CL/SL/EL seeding
    accrual.ts                accrueForOrg() / accrueForAllOrgs() — the monthly accrual engine
    balances.ts               getEffectiveAvailableDays() — the submission-time reservation formula
    leaveRequests.service.ts  submit / cancel / approve / reject — the balance-critical transactions
    leave.routes.ts           GET /leave/types, /leave/balances/*, POST /admin/leave/accrual/run
    leaveRequests.routes.ts   /leave/requests/*
    systemAccrual.routes.ts   POST /system/leave/accrual/run-all — secret-header gated, no session (cron target)
  holidays/
    holidays.ts               getHolidayDateKeys() — builds the holiday set countWorkingDays takes
    holidays.routes.ts        Holiday calendar CRUD + bulk upload
  attendance/
    derivation.ts             deriveDailyStatus() — the ONE place attendance/leave/holiday reconciliation lives
    attendance.service.ts     checkIn / checkOut / markAttendance
    attendance.routes.ts      Check-in/out, month + day views, HR mark
    regularizations.service.ts  submit / cancel / list-pending / approve / reject
    regularizations.routes.ts   Employee-requested attendance corrections
```

## Data model

- Better Auth core models — `User`, `Session`, `Account`, `Verification` — plus the organization plugin's `Organization`, `Member`, `Invitation`. These are generated by the Better Auth CLI (`npm run auth:generate`), not hand-edited.
- `Employee` is the one domain model owned by this app, and it's **HR-first**: an
  `Employee` is an HR record that can exist with no linked login at all.
  `userId` is nullable (still `@unique` — Postgres allows multiple NULLs under a
  unique constraint, so any number of not-yet-invited employees can coexist).
  `email` is the stable per-tenant identifier (`@@unique([organizationId, email])`
  — unique within a company, not globally) that a portal-login invite (see
  "Inviting an employee" below) links back to this record via `userId`.
  `invitedAt` is `null` until an invite is sent — "has portal login" is just
  `userId != null`, there's no separate status enum for it. Deleting the linked `User` sets
  `userId` back to `null` (`onDelete: SetNull`, not `Cascade`) rather than
  deleting the HR record, since login and HR record are independent.
  `EmployeeRole` (`ADMIN`, `HR`, `MANAGER`, `EMPLOYEE`) and the `managerId` /
  `reports` self-relation are unchanged. `joiningDate` (nullable) is new —
  used only for leave-accrual eligibility (see below); `null` is treated as
  "always eligible" so existing employees aren't blocked from accruing.
- `LeaveType` — one row per (org, leave code), e.g. `CL`/`SL`/`EL`
  (`@@unique([organizationId, code])`). `accrualPerMonth` (`Decimal`) is
  credited monthly up to `annualCap` (days/year). `isPaid`/`allowHalfDay` are
  metadata — `allowHalfDay` now gates half-day requests, see "Leave requests"
  below.
- `LeaveBalance` — one row per (employee, leave type, year)
  (`@@unique([employeeId, leaveTypeId, year])`). Stores `accruedDays` and
  `usedDays` (both `Decimal`, avoids float drift on day amounts);
  **available balance is computed as `accruedDays - usedDays`, never
  stored.** `lastAccruedMonth` (1-12) is the last calendar month the accrual
  engine applied for that year — see "Leave: types, balances & accrual"
  below.
- `LeaveRequest` — one row per submission. `workingDays` (`Decimal`) is
  computed by `countWorkingDays` at submission time and stored — it's the
  amount reserved against the balance while `status: PENDING`, and the
  amount moved into `LeaveBalance.usedDays` on `APPROVED`.
  `status: LeaveStatus` (`PENDING | APPROVED | REJECTED | CANCELLED`).
  `decidedByEmployeeId`/`decidedAt`/`decisionNote` are set on
  approve/reject, null until then. See "Leave requests" below for the full
  lifecycle and the reservation-vs-deduction model.
- `Holiday` — one company holiday per date per org
  (`@@unique([organizationId, date])`, indexed on `[organizationId, year]`).
  `date` is `@db.Date` (a calendar date, not an instant); `year` is derived
  from `date` at write time — there's no computed-column support here, and
  it exists purely so "the org's calendar for 2026" is a plain indexed
  lookup. See "Holiday calendar" below.
- `AttendanceRecord` — one row per (employee, day), `@@unique([employeeId,
  date])`. **Deliberately sparse:** a row exists only for days something was
  actually recorded (a check-in or an HR mark); days with no row still get a
  status from `deriveDailyStatus`, so nothing pre-seeds a row per employee
  per day. `status: AttendanceStatus` (`PRESENT | ABSENT | HALF_DAY |
  ON_LEAVE | HOLIDAY | WEEK_OFF`), `source: AttendanceSource` (`SELF |
  HR_MARKED | SYSTEM | REGULARIZED`). `workedMinutes` is derived at check-out
  and stays null while a day is still open. See "Attendance" below.
- `RegularizationRequest` — an employee-initiated request to correct their
  own attendance for one day, decided by any MANAGER/HR/ADMIN. Approving
  writes the correction onto the `AttendanceRecord`; the request row is kept
  as the audit trail (who asked, who decided, when, why). "At most one
  `PENDING` per (employee, date)" is a **partial** unique index, hand-written
  in the migration — see "Attendance regularization" below.

Because the Better Auth CLI overwrites `prisma/schema.prisma` wholesale on each run, the `Employee` model and the `employee`/`employees` reverse-relation fields on `User`/`Organization` are hand-maintained — re-add them if you ever regenerate and see them missing.

## API response envelope

> **Frontend-breaking change:** every route below except `/api/auth/*` (which
> stays in Better Auth's native shape) now wraps its response. Update the
> frontend API wrapper accordingly.

- Success: `{ "success": true, "data": <payload> }`, HTTP status unchanged
  from before (e.g. `201` on create).
- Error: `{ "success": false, "error": { "code", "message", "details"? } }`.
  `code` is one of `VALIDATION | UNAUTHORIZED | FORBIDDEN | NOT_FOUND |
  CONFLICT | INTERNAL`. `details` is present for `VALIDATION` errors (zod's
  field-level tree) and omitted otherwise.

Routes throw `AppError(statusCode, code, message, details?)`
([src/core/errors.ts](src/core/errors.ts)) for known failures, or let a zod
`.parse()` / Prisma error bubble up — a single `setErrorHandler`
([src/core/plugins/errorHandler.ts](src/core/plugins/errorHandler.ts)) turns all three
into the envelope above. Prisma's `P2002` (unique constraint) becomes `409
CONFLICT` and `P2025` (not found) becomes `404 NOT_FOUND` automatically, so
routes no longer pre-check things the database already enforces (e.g. the
`organizationId_email` uniqueness on `Employee`).

## Auth guard

`src/core/plugins/authGuard.ts` adds two preHandlers, used as route options
(`{ preHandler: app.requireRole([...]) }`):

- `app.requireAuth` — session must be valid (401), must have an active org on
  the session, and the caller must have an `Employee` row in that org (403
  otherwise). Populates `request.auth = { userId, organizationId, employeeId,
  role }`.
- `app.requireRole(roles: EmployeeRole[])` — same as `requireAuth`, plus a
  403 if `request.auth.role` isn't in `roles`.

Handlers read `organizationId`/`role` from `request.auth`, never from the
request body/query — that's the one source of tenant truth for every guarded
route.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness |
| GET | `/health/db` | Runs `SELECT 1` against Postgres |
| GET/POST | `/api/auth/*` | Better Auth (sign-up, sign-in, session, organization endpoints, etc.) |
| GET | `/me` | 401 without a session; otherwise the user + `activeOrganizationId` |
| POST | `/api/register-company` | Bootstraps a new tenant — see "Registering a company" below |
| POST | `/api/employees` | ADMIN/HR only. Create an `Employee` (no login — `userId` stays `null`) |
| GET | `/api/employees` | ADMIN/HR only. Paginated list, `?page=&pageSize=` (default 1/20, max pageSize 100) |
| GET | `/api/employees/:id` | ADMIN/HR only. 404 if the id belongs to another org |
| PATCH | `/api/employees/:id` | ADMIN/HR only. Partial update of HR fields |
| POST | `/api/employees/:id/invite` | ADMIN/HR only. Send/resend a portal-login invite for an existing `Employee` |
| GET | `/api/employees/:id/invite-link` | ADMIN/HR only. Manual-link fallback — see "Inviting an employee" below |
| GET | `/api/invitations` | ADMIN/HR only. Pending invitations in the active org |
| POST | `/api/invitations/:id/cancel` | ADMIN/HR only. Cancel a pending invitation |
| GET | `/api/employees/org-chart` | Any org member. Full reporting tree — see "Org chart" below |
| GET | `/api/employees/:id/reports` | Any org member. One employee's direct reports, same lightweight shape |
| GET | `/leave/types` | Any org member. Active leave types for the caller's org |
| GET | `/leave/balances/me` | Any org member. The caller's own accrued/used/available balances (current year) |
| GET | `/leave/balances/:employeeId` | ADMIN/HR only. That employee's balances, tenant-scoped |
| POST | `/admin/leave/accrual/run` | ADMIN only. Manually run accrual for the caller's org — see "Leave: types, balances & accrual" below |
| POST | `/system/leave/accrual/run-all` | No session — `X-Accrual-Secret` header instead. Runs accrual for every org; the monthly cron's target |
| POST | `/leave/requests` | Any org member. Submit a leave request for yourself — see "Leave requests" below |
| GET | `/leave/requests/me` | Any org member. Your own requests, optional `?status=` filter |
| POST | `/leave/requests/:id/cancel` | Any org member. Cancel your OWN request — PENDING only |
| GET | `/leave/requests/pending` | MANAGER/HR/ADMIN only. Org-wide approver queue |
| POST | `/leave/requests/:id/approve` | MANAGER/HR/ADMIN only. Deducts `usedDays` atomically |
| POST | `/leave/requests/:id/reject` | MANAGER/HR/ADMIN only. No balance change |
| GET | `/holidays?year=YYYY` | Any org member. The org's holiday calendar for a year (defaults to current) |
| POST | `/holidays` | ADMIN/HR only. Add one holiday `{ date, name }` |
| POST | `/holidays/bulk` | ADMIN/HR only. Idempotent bulk upsert of a month's or a year's list |
| DELETE | `/holidays/:id` | ADMIN/HR only. 404 if the holiday belongs to another org |
| POST | `/attendance/check-in` | Any org member, for themselves. Rejected on a week off / holiday / approved-leave day |
| POST | `/attendance/check-out` | Any org member. Computes `workedMinutes` and the PRESENT/HALF_DAY split |
| GET | `/attendance/me?month=YYYY-MM` | Any org member. Their full month, every day with a derived status |
| GET | `/attendance?date=YYYY-MM-DD` | ADMIN/HR only. The org's derived status for one day, all employees |
| GET | `/attendance/:employeeId?month=YYYY-MM` | ADMIN/HR only. One employee's month, tenant-scoped |
| POST | `/attendance/mark` | ADMIN/HR only. Mark or correct one employee's day (`source: HR_MARKED`) |
| POST | `/attendance/regularizations` | Any org member, for themselves. Request a correction for a past working day |
| GET | `/attendance/regularizations/me` | Any org member. Their own requests, optional `?status=` filter |
| POST | `/attendance/regularizations/:id/cancel` | Any org member. Cancel their OWN `PENDING` request |
| GET | `/attendance/regularizations/pending` | MANAGER/HR/ADMIN only. Approver queue with before/after context |
| POST | `/attendance/regularizations/:id/approve` | MANAGER/HR/ADMIN only. Applies the correction (`source: REGULARIZED`) |
| POST | `/attendance/regularizations/:id/reject` | MANAGER/HR/ADMIN only. No attendance change |

## Email & password reset

`src/core/email.ts` wraps [Resend](https://resend.com) behind a single `sendEmail({ to, subject, html })`
function — nothing else in the codebase should call the Resend SDK directly.
`src/core/auth.ts` uses it for Better Auth's `sendResetPassword` and
`sendVerificationEmail` hooks.

**Testing the reset flow locally** (no Resend account needed): leave
`RESEND_API_KEY` unset in `.env`. `POST /api/auth/request-password-reset`
with a known email will log the reset link (with token) to the console
instead of sending it — copy that link and call
`POST /api/auth/reset-password` with the token and new password. Password
reset tokens expire after 1 hour and revoke all existing sessions for that
user on success.

**Turning on email verification**: set `REQUIRE_EMAIL_VERIFICATION=true` in
`.env`. This blocks sign-in for unverified users and starts sending
verification emails through the same `sendEmail` path — no code change
needed, just the env var (the frontend also needs a page to land users on
after they click the verification link, which is out of scope here).

**Rate limiting** on auth endpoints is handled by Better Auth's built-in
limiter (see the comment in `src/core/auth.ts`) rather than a separate
package — it already ships tighter windows for sign-in/sign-up and
password-reset/verification requests than its general default.

## Registering a company

`POST /api/register-company` bootstraps a new tenant: it creates the Better
Auth `User`, the `Organization`, an `owner` `Member`, the domain `Employee`
(`role: ADMIN`), and sets that organization active on the new session — all
via the shared `registerCompany()` helper in `src/modules/identity/registerCompany.ts` (also
used by the seed script). Employees themselves are invite-only and are not
created by this endpoint; it only exists to create the *first* admin for a
brand-new company.

Body: `{ companyName, fullName, email, password }` (password same policy as
sign-up: 10–128 chars). Response: `{ user, organization }`, plus a `Set-Cookie`
for the new session — no token or password is ever returned in the body.

While `ENABLE_PUBLIC_SIGNUP=false` (the default), the endpoint requires an
`X-Registration-Secret` header matching `REGISTRATION_SECRET`:

```bash
curl -X POST http://localhost:4000/api/register-company \
  -H "Content-Type: application/json" \
  -H "X-Registration-Secret: $REGISTRATION_SECRET" \
  -d '{"companyName":"Acme Inc","fullName":"Ada Admin","email":"ada@acme.test","password":"supersecret123"}'
```

Signed-in users cannot self-service create additional organizations through
Better Auth's own `/api/auth/organization/create` endpoint
(`allowUserToCreateOrganization: false` in `src/core/auth.ts`) — this endpoint
is the only path that creates an org, because it's the only path that also
creates the required `Employee` row.

If `registerCompany()` fails after the `User`/`Organization` already exist
(e.g. `Employee` creation fails), it best-effort deletes both and logs loudly
if that cleanup itself fails — check server logs for `ORPHAN LEFT BEHIND` if a
registration ever 500s.

## Employee CRUD

All four endpoints (`src/modules/employees/employees.routes.ts`) share one gate:
`app.requireRole(["ADMIN", "HR"])` (see "Auth guard" above) — otherwise
401/403. Every query/mutation is scoped to `request.auth.organizationId`; it
is never read from the request body.

- `POST /api/employees` — body `{ fullName, email, role, designation?, managerId? }`.
  `role` must be `HR`, `MANAGER`, or `EMPLOYEE` — this endpoint can't mint
  another `ADMIN`. `userId` is always `null` on create (no login exists yet).
  409 if `email` is already used in the org; 400 if `managerId` doesn't
  resolve to an `Employee` in the same org.
- `PATCH /api/employees/:id` — same body, all fields optional; `designation`
  and `managerId` accept `null` to clear them. Same role restriction as
  create (still can't set `role: "ADMIN"`), same same-org `managerId` check,
  plus a same-org email-uniqueness check on `email` changes, plus a guard
  against an employee being set as their own manager. Deeper cycle detection
  (A -> B -> A) is a TODO, not enforced yet.
- `GET /api/employees` — paginated (`page`, `pageSize`, default 1/20, max
  pageSize 100), ordered by `fullName`. Each row includes a `manager: {id,
  fullName} | null` summary via a single Prisma `include` (no N+1).
- `GET /api/employees/:id` — 404 (not 403) if the id exists but belongs to a
  different org, so it doesn't leak cross-tenant existence.

## Org chart

`GET /api/employees/org-chart` and `GET /api/employees/:id/reports`
(`src/modules/employees/employees.routes.ts`, tree assembly in `src/modules/employees/orgChart.ts`) are gated
by `app.requireAuth` only — any authenticated member of the org can view
them, unlike the ADMIN/HR-only CRUD above.

Node shape (both endpoints): `{ id, fullName, role, designation,
hasPortalAccess }` — no `email`, no `organizationId`, nothing beyond what's
needed to render a chart. `org-chart` nodes additionally nest `reports:
Node[]`.

- `GET /api/employees/org-chart` — `data: { tree: Node[] }`. One
  `prisma.employee.findMany` for the whole org, then `buildOrgChartTree`
  assembles the forest in memory — no per-node queries. Employees with
  `managerId: null` are roots; so are employees whose `managerId` points
  outside the org (shouldn't happen, but tenant-scoping the query alone can't
  rule it out) — logged as a warning and surfaced as a root rather than
  dropped. A `managerId` cycle (data corruption — the same thing `PATCH
  /api/employees/:id` guards against on write, see above) can't recurse
  forever: each employee is attached to the tree at most once, so the second
  time a cycle is walked into it's skipped with a warning instead of looping.
  See `src/modules/employees/orgChart.test.ts` for the multi-root/orphan/cycle cases.
- `GET /api/employees/:id/reports` — `data: { reports: Node[] }`, direct
  reports only (not the whole subtree), tenant-scoped, ordered by `fullName`.
  404 if `:id` doesn't resolve to an `Employee` in the caller's org.

## Leave: types, balances & accrual

**Model: monthly accrual.** Each active `LeaveType` credits `accrualPerMonth`
to every eligible employee's `LeaveBalance` once per calendar month, capped
at `annualCap` for the year. "Eligible" means `Employee.joiningDate` is null
or falls on/before the accrual month — no proration for a mid-month join,
they get the full month once eligible. There's no employee
"active/terminated" status field yet, so every `Employee` row in the org is
accrual-eligible; add one before building offboarding.

Accrual itself is month-based, not day-based, so it doesn't use
`countWorkingDays` — weekends only come into play once actual dates are
being counted, which is the request lifecycle below.

**Default leave types.** `ensureDefaultLeaveTypes()`
([src/modules/leave/leaveTypes.ts](src/modules/leave/leaveTypes.ts)) upserts CL (1/mo, cap 12),
SL (1/mo, cap 12), EL (1.5/mo, cap 18) for an org, keyed on the
`organizationId_code` unique constraint — `update: {}` on conflict, so
calling it again (or for an org that already has them) never clobbers an
admin's later edits. `registerCompany()` calls it right after creating the
ADMIN `Employee`, so every new org starts with all three; if it throws, the
same rollback that already covers a failed `Employee` create (delete the
just-created `Organization`/`User`) applies here too.

**The accrual engine** — `accrueForOrg(organizationId, year, month)`
([src/modules/leave/accrual.ts](src/modules/leave/accrual.ts)):

1. One query for every `Employee` in the org, one for every active
   `LeaveType` with `accrualPerMonth > 0` — no per-employee/per-type
   queries.
2. For each eligible employee, all of that employee's leave-type balance
   updates for the run are wrapped in a single `prisma.$transaction` — a
   failure partway through rolls back that employee's whole batch instead of
   leaving some types credited and others not. A failure doesn't stop the
   run; it's counted in `employeesFailed` and logged, and the next employee
   still gets processed.
3. Per (employee, leaveType, year): upsert the `LeaveBalance` row, then skip
   if `lastAccruedMonth >= month` (already applied) — this is what makes
   re-running a month a no-op and lets a missed month be applied later
   regardless of what today's date is. Otherwise credit
   `min(accrualPerMonth, annualCap - accruedDays)` (never negative) and set
   `lastAccruedMonth = month`.

`accrueForAllOrgs(year, month)` just loops every `Organization` through
`accrueForOrg` — used by the system endpoint below. Both are exercised by
[src/modules/leave/accrual.test.ts](src/modules/leave/accrual.test.ts) (idempotency +
cap, against disposable data in the real dev DB — this is a balance-critical
path, not something to leave unverified).

**Two ways to run it:**

- `POST /admin/leave/accrual/run` — ADMIN only (narrower than the ADMIN/HR
  gate used elsewhere, since this credits real balances), scoped to
  `request.auth.organizationId`. Body `{ year?, month? }`, both default to
  the current date. For manual/testing runs.
- `POST /system/leave/accrual/run-all` — no Better Auth session; gated
  instead by an `X-Accrual-Secret` header that must match the `ACCRUAL_SECRET`
  env var (401 otherwise). Runs `accrueForOrg` for **every** org, for the
  *current* month only (no `year`/`month` body — this is the unattended
  path). This is what a monthly cron should call.

**Wiring the monthly cron** (Railway/Render "scheduled job" or any external
scheduler that can hit an HTTP endpoint once a month):

```bash
curl -X POST https://<your-api-host>/system/leave/accrual/run-all \
  -H "X-Accrual-Secret: $ACCRUAL_SECRET"
```

Schedule it for the 1st of the month (or any day — it's idempotent and
catches up on a missed month automatically, so an occasional late/duplicate
run is harmless). Keep `ACCRUAL_SECRET` out of anywhere but the cron
scheduler's own secret store and this API's env.

**Balance reads** — `GET /leave/balances/me` and `GET
/leave/balances/:employeeId` both return `data: { year, balances: [{
leaveTypeId, code, name, accruedDays, usedDays, availableDays }] }` for every
*active* `LeaveType` in the org, joined in memory with any existing
`LeaveBalance` row for the current year — a type with no balance row yet
(accrual hasn't run this year) still shows up at zero instead of being
omitted. `availableDays` is computed (`accruedDays - usedDays`), never
stored.

## Leave requests

**Lifecycle:** `PENDING` → `APPROVED` | `REJECTED`, or the requester cancels
their own `PENDING` request → `CANCELLED`. Any `MANAGER`/`HR`/`ADMIN` in the
org can approve or reject **any** pending request — flexible routing, not
strict manager-of-record (locked decision for this stage).

**`countWorkingDays(startDate, endDate, isHalfDay, holidayDateKeys?)`**
([src/shared/workingDays.ts](src/shared/workingDays.ts)) is the **one and only**
place day-counting/weekend/holiday logic lives in the whole codebase — every
balance calculation that counts days routes through it. It excludes Sat/Sun
**and** any injected company holidays, and returns `0.5` for a
(single-day-only) half day. Dates are handled in UTC throughout (matches how
Prisma round-trips the `@db.Date` columns), so day-of-week doesn't drift with
the server's local timezone. Verified by
[src/shared/workingDays.test.ts](src/shared/workingDays.test.ts).

Holidays are **injected, not queried inside** — the function stays pure and
synchronous, so it's testable without a database and does no hidden I/O.
Callers build the set first with `getHolidayDateKeys(db, organizationId,
startDate, endDate)` ([src/modules/holidays/holidays.ts](src/modules/holidays/holidays.ts)), which
pairs the tenant-scoped query with the same `toUtcDateKey` formatting the
counter looks up — that pairing is why the key format can't silently drift
apart (a real failure mode, covered by a DB round-trip test in
`holidays.test.ts`).

**Reservation vs. deduction — the two balance checks are deliberately
different:**

- **Submission** (`POST /leave/requests`) uses the *effective available*
  formula — `accruedDays - usedDays - (this employee's own PENDING requests
  for the same leave type/year)` — via `getEffectiveAvailableDays`
  ([src/modules/leave/balances.ts](src/modules/leave/balances.ts),
  tested in `leaveRequests.test.ts`). Subtracting pending reservations is
  what stops two overlapping/oversized pending submits from both fitting
  under the same real balance — a `PENDING` request reserves but never
  touches `usedDays`.
- **Approval** (`POST /leave/requests/:id/approve`) deliberately does
  **not** reuse that formula — it checks the plain real balance
  (`accruedDays - usedDays`) instead. Reasoning: by approval time, only
  whether the real balance still covers *this* request matters; other still-
  pending requests are each judged independently when their own turn comes,
  so they shouldn't block this one. Approving increments `usedDays` by
  `workingDays` in the same transaction that flips `status: APPROVED`.
- **Reject/cancel** touch no balance at all — a `PENDING` request was only
  ever a reservation, so moving it to `REJECTED`/`CANCELLED` just frees that
  reservation for the next `getEffectiveAvailableDays` call to see.

**Concurrency:** submission (read-reservation-then-insert) and approval
(read-balance-then-increment) are both read-then-write sequences that Postgres's
default READ COMMITTED isolation wouldn't fully protect against two
simultaneous callers each passing the check before either commits. Both run
inside a `Serializable` Prisma transaction instead, so Postgres aborts one
side of any real conflict rather than letting both apply — surfaced by the
central error handler as `409 CONFLICT` (Prisma error `P2034`, "please
retry"; see [src/core/plugins/errorHandler.ts](src/core/plugins/errorHandler.ts)).
Approval's status check (`still PENDING?`) is re-verified inside that same
transaction, so a request already decided by someone else cleanly 409s
instead of double-applying.

**Endpoints** (bodies/behavior beyond the table above):

- `POST /leave/requests` — body `{ leaveTypeId, startDate, endDate,
  isHalfDay?, reason? }`. Validates: `leaveTypeId` is active and in the
  caller's org; `endDate >= startDate`; `isHalfDay` only for a single-day
  range and only if `LeaveType.allowHalfDay`; rejects a weekend-only range
  (`countWorkingDays` returns 0); rejects if it overlaps the requester's own
  `PENDING`/`APPROVED` requests **for any leave type** (can't be on two
  leaves at once); rejects if `workingDays` exceeds the effective available
  balance. `employeeId` always comes from `request.auth`, never the body.
- `GET /leave/requests/me` — optional `?status=PENDING|APPROVED|REJECTED|CANCELLED`.
- `POST /leave/requests/:id/cancel` — requester only, own request only,
  `PENDING` only (kept simple for now — cancelling a future-dated `APPROVED`
  request is a possible later extension). 404 if it's not the caller's
  request or belongs to another org; 409 if it's no longer `PENDING`.
- `GET /leave/requests/pending` — org-wide queue, includes `employee: {id,
  fullName}` and `leaveType: {id, name, code}` via a single Prisma
  `include` each (no N+1).
- `POST /leave/requests/:id/approve` / `.../reject` — optional body
  `{ decisionNote? }`. Both 404 if the request isn't in the caller's org,
  409 if it's no longer `PENDING`. **Self-approval is allowed** (any
  approver-role employee, including the requester themselves if they hold
  `MANAGER`/`HR`/`ADMIN`) — `src/modules/leave/leaveRequests.service.ts` has a `TODO`
  flagging this as a policy option to revisit once approval routing gets
  stricter than "any approver role in the org".

## Holiday calendar

Per-org company holidays ([src/modules/holidays/holidays.routes.ts](src/modules/holidays/holidays.routes.ts)),
excluded from leave day-counting alongside weekends — leave spanning a
holiday costs the employee fewer leave days. Management is ADMIN/HR only;
**reading is open to any org member**, since everyone needs to see the
company calendar.

> **No retroactive recompute.** Editing the calendar only affects **new**
> leave submissions. Existing requests keep the `workingDays` they were
> stored with at submission — including `PENDING` ones — and approved
> deductions are never revisited. Adding a holiday in the middle of a month
> will not refund anyone who already booked leave across it; that would mean
> silently rewriting balances, so it's a deliberate non-goal. Cancel and
> resubmit if a request genuinely needs recounting.

- `GET /holidays?year=YYYY` — `data: { year, holidays: [{ id, date, name,
  year }] }`, ordered by date, defaulting to the current year.
- `POST /holidays` — body `{ date, name }`. A duplicate date hits the
  `organizationId_date` unique constraint and surfaces as `409 CONFLICT` via
  the central error handler; use the bulk endpoint if you want upsert
  semantics instead.
- `POST /holidays/bulk` — body `{ holidays: [{ date, name }, ...] }` (1–366
  entries). **One endpoint covers both "upload a month" and "upload a year"
  — it's just a longer or shorter list.** Upserts on `(organizationId,
  date)` inside a transaction, so re-uploading the same list is idempotent
  and never creates duplicates. Returns
  `data: { added, updated, unchanged, duplicatesInPayload, received }` —
  `updated` means the date already existed with a *different* name,
  `unchanged` means it was already identical. A date repeated within a single
  payload is de-duplicated (last entry wins) and counted in
  `duplicatesInPayload`, since upserting the same row twice in one
  transaction would otherwise self-conflict.
- `DELETE /holidays/:id` — scoped via `deleteMany` on `{ id, organizationId }`
  so a holiday in another org matches nothing and 404s rather than being
  deleted across the tenant boundary.

A leave range that is entirely weekends and/or holidays counts 0 working days
and is rejected by the existing "no working days" rule.

## Attendance

Self check-in/out plus HR marking ([src/modules/attendance/attendance.routes.ts](src/modules/attendance/attendance.routes.ts)),
reconciled against leave, holidays and weekends by one isolated function.
For employee-initiated corrections see "Attendance regularization" below.

**`deriveDailyStatus(...)`** ([src/modules/attendance/derivation.ts](src/modules/attendance/derivation.ts))
is **THE ONE PLACE** attendance/leave/holiday/weekend reconciliation lives —
the attendance counterpart to `countWorkingDays`. Nothing else decides what a
given day "is"; every view (self month, HR day, HR month) *and* the check-in
guard route through it, so they cannot disagree. It reuses `isWeekend` from
[src/shared/workingDays.ts](src/shared/workingDays.ts) rather than re-deriving the
weekend rule.

Priority order — first match wins:

| # | Condition | Status |
| --- | --- | --- |
| 1 | Saturday/Sunday | `WEEK_OFF` |
| 2 | Org holiday that day | `HOLIDAY` |
| 3 | Approved leave covering that day | `ON_LEAVE` |
| 4 | A record exists | HR's stored status if `source: HR_MARKED`, else `PRESENT`/`HALF_DAY` by worked time |
| 5 | Past working day, no record | `ABSENT` |
| 6 | Today or future, no record | `null` — not yet determined |

`null` is deliberately **not** an `AttendanceStatus` member: "we don't know
yet" isn't a state worth persisting, and today shouldn't read as an absence
before the day is over. Layer 4 lets an HR correction (including a forced
`ABSENT`) beat recomputing from clock times, since it's an explicit human
decision.

Like `countWorkingDays`, it's **pure and synchronous** — all data is
injected, including `today`, so it's fully testable without a database or a
clock. Callers bulk-load first via `loadAttendanceContext`, which fetches
holidays, approved leave and existing records in **exactly three queries**
regardless of how many employees or days are in range. That's what keeps the
month and day views free of N+1. Approved leave is stored as ranges and
expanded to per-day keys in memory.

**Half-day threshold:** `ATTENDANCE_HALF_DAY_THRESHOLD_MINUTES` (default
`240` = 4h of an 8h day). `statusFromWorkedMinutes` is the single rule
comparing worked time to it — check-out uses it to *store* a status and
derivation uses it to *read* one back, which is why the two can't drift on
the comparison. A day checked in but not yet out (`workedMinutes: null`)
counts as `PRESENT`, not a half day — the day is still open.

**Endpoints:**

- `POST /attendance/check-in` — `employeeId` always from `request.auth`,
  never the body. Upserts today's record with `checkInAt` and `source: SELF`.
  409 if already checked in, or if today derives to `WEEK_OFF`/`HOLIDAY`/
  `ON_LEAVE` (each with its own message). Runs in a `Serializable`
  transaction so two simultaneous check-ins can't both insert.
- `POST /attendance/check-out` — sets `checkOutAt`, computes `workedMinutes`,
  and stores the PRESENT/HALF_DAY split. 409 if there's no check-in today, or
  if already checked out.
- `GET /attendance/me?month=YYYY-MM` — defaults to the current month. Returns
  `data: { year, month, days: [{ date, status, checkInAt, checkOutAt,
  workedMinutes, source, note }] }` for **every** day of the month.
- `GET /attendance?date=YYYY-MM-DD` — defaults to today. Every employee in
  the org with their derived status for that day.
- `GET /attendance/:employeeId?month=YYYY-MM` — 404 if the employee is in
  another org.
- `POST /attendance/mark` — body `{ employeeId, date, status?, checkInAt?,
  checkOutAt?, note? }` (at least one of status/checkInAt/checkOutAt).
  Upserts with `source: HR_MARKED`. Times merge with what's already stored
  (so in-now/out-later across two calls recomputes correctly), and an
  explicit `status` wins over the worked-time rule.

> **Timezone caveat:** calendar days are UTC throughout, matching the rest of
> the codebase (`@db.Date` columns). For IST (UTC+5:30) a check-in before
> 05:30 local lands on the previous UTC day. Fine for a single-timezone
> Indian SME during working hours, but a per-org timezone is the right fix
> before this goes anywhere multi-region.

## Attendance regularization

Employee-initiated attendance corrections
([src/modules/attendance/regularizations.service.ts](src/modules/attendance/regularizations.service.ts)): the
employee asks, any MANAGER/HR/ADMIN decides, and an approval applies the
correction to the `AttendanceRecord`.

**Mark vs. regularize — two different write paths, deliberately:**

| | `POST /attendance/mark` | `POST /attendance/regularizations` → approve |
| --- | --- | --- |
| Who starts it | ADMIN/HR | The employee, for themselves |
| Approval | None — applied immediately | Any MANAGER/HR/ADMIN must approve |
| Audit trail | The record's `note` | A `RegularizationRequest` row: reason, decider, decision note, timestamps |
| Record `source` | `HR_MARKED` | `REGULARIZED` |

Both are explicit human decisions and both beat recomputing status from clock
times; they differ in *who initiates* and *whether there's a reviewable
paper trail*. `mark` stays as the direct HR override for routine fixes.

**New `AttendanceSource.REGULARIZED`.** Kept distinct from `HR_MARKED` so the
audit trail separates "HR edited this directly" from "the employee asked and
an approver agreed". Because both must override worked-time recomputation,
`deriveDailyStatus` classifies them through one named predicate
(`isExplicitHumanDecision`) rather than a bare `=== "HR_MARKED"` comparison —
without that, an approved correction whose status disagrees with the clock
(a granted `HALF_DAY` on a day with full punches, a forced `ABSENT`) would be
silently recomputed away. There's a regression test pinning exactly that.

**Lifecycle:** `PENDING` → `APPROVED` | `REJECTED`, or the requester cancels
their own `PENDING` → `CANCELLED`. Only approval touches the
`AttendanceRecord`; reject and cancel change nothing, since a pending request
never applied anything in the first place.

**At most one open request per date** is enforced by a **partial** unique
index, hand-written in the migration because Prisma's `@@unique` can't
express a `WHERE` clause:

```sql
CREATE UNIQUE INDEX "RegularizationRequest_one_pending_per_employee_date"
  ON "RegularizationRequest"("employeeId", "date") WHERE status = 'PENDING';
```

Partial, not plain: a plain unique index would wrongly block re-requesting a
date after a rejection. The route also pre-checks (for a clear error
message), but that check races under concurrent submits — the index is the
actual guarantee, surfacing as `409 CONFLICT` via the existing `P2002`
mapping.

**Endpoints:**

- `POST /attendance/regularizations` — body `{ date, type, requestedCheckInAt?,
  requestedCheckOutAt?, requestedStatus?, reason }`. `type` is
  `MISSING_PUNCH | WRONG_TIME | WFH | OTHER`. `employeeId` always from
  `request.auth`. Validation: date not in the future; at least one of the
  three `requested*` fields; `reason` required; `requestedCheckInAt` must
  fall on the date being regularized; `requestedCheckOutAt` must be after it
  (**not** required to be the same day — an overnight shift legitimately
  punches out after midnight). 409 if the date derives to `WEEK_OFF` or
  `HOLIDAY` (nothing to regularize) — checked via `deriveDailyStatus`, not a
  second copy of that logic.
- `GET /attendance/regularizations/me` — optional `?status=` filter.
- `POST /attendance/regularizations/:id/cancel` — own `PENDING` only.
- `GET /attendance/regularizations/pending` — each row carries the requester
  summary plus `current: { status, checkInAt, checkOutAt, workedMinutes }`,
  the **currently derived** state of that date, so the approver sees
  before-vs-after. One bulk `loadAttendanceContext` spanning every queued
  date, so this costs the same 3 queries whether the queue holds 1 row or
  500.
- `POST /attendance/regularizations/:id/approve` — in a `Serializable`
  transaction: re-checks still `PENDING`, upserts the `AttendanceRecord`
  merging requested times over whatever is already stored (a null requested
  field means "leave it alone"), recomputes `workedMinutes` when both punches
  are present, and applies `requestedStatus` if given — otherwise falling
  back to the shared `statusFromWorkedMinutes` rule so a pure missing-punch
  fix lands on the same PRESENT/HALF_DAY split a self check-out would have
  produced. Returns both the updated request and the resulting record.
- `POST /attendance/regularizations/:id/reject` — sets `REJECTED` with the
  decision fields; no record change.

**Self-approval is allowed** for now (an approver-role employee can approve
their own regularization) — `src/modules/attendance/regularizations.service.ts` carries a `TODO`
flagging it as a policy option, matching the same open question on leave
approvals.

## Inviting an employee

Portal login is granted to an **existing** `Employee` record via invite — this
never creates a second `Employee`; accepting always links back to the one HR
already created.

**Custom org roles.** Better Auth's organization plugin gets four custom
roles mirroring `EmployeeRole` lowercased (`admin`, `hr`, `manager`,
`employee` — defined in `src/core/auth.ts` via `defaultAc.newRole(...)`), so
an invited employee's Better Auth org role carries their `EmployeeRole`
through. Only `admin` and `hr` get `invitation: ["create", "cancel"]`,
matching the ADMIN/HR-only gate on these routes. `owner` (whoever ran
`/api/register-company`) is Better Auth's own built-in role and is
untouched — but note `hasPermission` resolves custom roles as
`options.roles || defaultRoles`, not a merge, so setting `roles` at all
required spreading `defaultRoles` back in first, or `owner` would have
silently lost every permission the moment a custom roles map was set. (This
bit us during testing — worth knowing if you ever touch the `roles` config.)

**End-to-end walkthrough:**

1. HR/ADMIN creates the employee record first (already has no login):
   ```bash
   curl -X POST http://localhost:4000/api/employees -H "Content-Type: application/json" -b cookies.txt \
     -d '{"fullName":"Hana HR","email":"hana@acme.test","role":"HR"}'
   ```
2. Invite them:
   ```bash
   curl -X POST http://localhost:4000/api/employees/<employeeId>/invite -b cookies.txt
   ```
   This calls Better Auth's `createInvitation` with `role` mapped from
   `Employee.role`, fires `sendInvitationEmail` (via `sendEmail` — console in
   dev, same as password reset), and sets `Employee.invitedAt`. Re-inviting
   before acceptance cancels the old pending invitation
   (`cancelPendingInvitationsOnReInvite: true`) rather than erroring.
   Invitations expire after 7 days (`invitationExpiresIn`). If the employee
   already has a login (`userId` set), this 409s. If the id belongs to
   another org, 404.
3. The invitee signs up (or signs in, if they already have an account) with
   the invited email, then accepts:
   ```bash
   curl -X POST http://localhost:4000/api/auth/organization/accept-invitation \
     -H "Content-Type: application/json" -b invitee_cookies.txt \
     -d '{"invitationId":"<invitationId>"}'
   ```
4. On accept, `organizationHooks.afterAcceptInvitation`
   (`src/modules/identity/invitations.ts` → `linkEmployeeOnAcceptInvitation`) finds the
   `Employee` by `(organizationId, email)` and sets `userId` on that *same*
   record — no new `Employee` is created. It also force-sets
   `activeOrganizationId` on the accepting user's session(s) directly via
   Prisma, since Better Auth's own `setActiveOrganization` call inside
   `acceptInvitation` doesn't always stick. Edge case: if no matching
   `Employee` exists (invited via Better Auth's own endpoint directly,
   bypassing step 2 above), it creates a minimal fallback `Employee` and logs
   a `console.warn` — check server logs for that if an employee ever shows up
   without having gone through this endpoint.

**Manual-link fallback** (`GET /api/employees/:id/invite-link`): if
`RESEND_API_KEY` isn't configured, the invite email already logs to console
in dev — but this endpoint returns the same accept URL as plain JSON
(`{ url, invitation }`) for copy-pasting from an admin UI instead of digging
through server logs. Requires an existing pending invitation for that
employee (i.e. call `/invite` first); 404s otherwise.

**Listing/cancelling**: `GET /api/invitations` lists pending invitations in
the caller's active org; `POST /api/invitations/:id/cancel` cancels one
(via Better Auth's `cancelInvitation`, so hooks/permissions still apply) —
both scoped to the active org regardless of what Better Auth's own
permission check would otherwise allow.

## Seeding a demo company

```bash
npm run db:seed
```

Runs the same bootstrap as above with fixed demo values (override via
`DEMO_COMPANY_NAME` / `DEMO_ADMIN_NAME` / `DEMO_ADMIN_EMAIL` /
`DEMO_ADMIN_PASSWORD` env vars — these aren't part of `src/env.ts` since
they're seed-only, not needed for the app to boot). Safe to run repeatedly:
it checks for the demo admin's email first and skips if found. Also runs
automatically after `prisma migrate dev` (wired via `migrations.seed` in
`prisma.config.ts`), or on demand with `npx prisma db seed`.

## Notes

- Prisma 7 requires a driver adapter — the connection string reaches `PrismaClient` through `@prisma/adapter-pg`, not through `schema.prisma`. Migration commands read it from `prisma.config.ts`.
- The generated client lands in `src/generated/prisma` and is gitignored; `npm run build` / `npm run db:generate` regenerate it.
- `request.getSession()` (declared via module augmentation in [src/core/plugins/auth.ts](src/core/plugins/auth.ts)) reads the session from request headers via Better Auth's `auth.api.getSession`. Use it in any route that needs to know the caller's identity.
- CORS is locked to the single `FRONTEND_ORIGIN` with `credentials: true`, required for Better Auth's cookie-based sessions to work cross-origin.
