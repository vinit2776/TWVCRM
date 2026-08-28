# Attendance Gateway

Employee attendance for The WorkVilla: biometric-device punches, self-service
punch in/out, leave / permission / overtime / field-trip workflows, and admin
reporting.

It is a **satellite** of the TWV CRM, not part of it. It lives in this repo as a
subdirectory for convenience, but at runtime it shares nothing with the CRM:

| | CRM | Attendance Gateway |
|---|---|---|
| Runtime | Next.js 16 / React | Plain Node `http`, no framework, no build step |
| Database | Supabase (PostgreSQL) | Turso / libSQL (SQLite) |
| Auth | Supabase Auth | Own `users` table, scrypt hashes, DB-backed sessions |
| Vercel project | `twv-crm` | `twv-attendance` |
| Domain | twv-crm.vercel.app | attendance.theworkvilla.com |

There is deliberately **no shared user base, session, or database** between the
two. The CRM's only reference to this app is an outbound link in the sidebar.

## Architecture

- **[server.js](server.js)** — the whole app: router, HTML rendering (template
  strings), auth, and every route. Exports a handler; the standalone HTTP
  listener only starts under `require.main === module`.
- **[attendance-logic.js](attendance-logic.js)** — pure attendance computation
  (shift matching, half-day/late rules, breaks, holidays, leave). The only part
  with unit tests, in [test/](test/).
- **[i18n.js](i18n.js)** — English and Tamil strings, chosen per employee.
- **[api/index.js](api/index.js)** — Vercel entry point. `vercel.json` rewrites
  every path here, so the router in `server.js` runs unchanged.
- **[relay/](relay/)** — office-LAN proxy for the biometric device. See below.

The schema is created and migrated in code at boot (`init()` in `server.js`),
not through migration files — `CREATE TABLE IF NOT EXISTS` plus idempotent
`ALTER TABLE`s, memoized so each serverless cold start runs it at most once.

## The biometric device

A ZKTeco K40 Pro pushes attendance logs over the ADMS protocol to `/iclock/*`.
Its firmware only speaks plain HTTP to a bare IP, so it cannot reach an HTTPS
domain directly. [relay/relay.js](relay/relay.js) runs as an always-on service on
an office Windows machine, accepts the device's local pushes and forwards them to
the cloud over HTTPS.

The relay is stateless. It passes the cloud's response straight back, so the
device only clears a log once the cloud has accepted it — if the internet is
down, nothing is lost and the device retries. Setup: [relay/README.md](relay/README.md).

## Running locally

```bash
cp .env.example .env   # fill in TURSO_*; SEED_DEMO_DATA=true gives you login accounts
npm install
npm start              # http://localhost:3001
npm test               # attendance-logic unit tests
```

`SEED_DEMO_DATA=true` creates `admin` / `admin123` and `EMP-001..5` /
`password123`. These are publicly-known credentials and must never be enabled on
a deployment reachable from the internet — production uses
`ADMIN_BOOTSTRAP_PASSWORD` instead, which creates one admin account with a
password only you know. Full list of variables: [.env.example](.env.example).

## Migrating from the old office database

The app previously ran on the office Windows machine against a local
`attendance.db`. Moving that history into Turso — and, critically, rotating the
seed credentials it carries with it — is documented step by step in
[docs/data-migration.md](docs/data-migration.md).

Two helper scripts support it:

```bash
npm run snapshot -- --file ./attendance.db   # fingerprint every table
npm run snapshot -- --turso                  # ...and again after import, to diff
npm run set-password -- admin '<password>'   # rotate a credential, revoking its sessions
```

## Deployment

Its own Vercel project, with **Root Directory** set to `attendance-gateway-code`
so this repo's CRM code is not part of its build. Both projects use an ignored
build step so a commit touching only one of them does not redeploy the other.

The single cron (`/internal/auto-checkout`, 19:00 IST) is declared in this
directory's own [vercel.json](vercel.json) and is protected by `CRON_SECRET`.

## Security notes

- `/iclock/*` is authenticated **only** by the device serial number in the query
  string. `ZK_DEVICE_SN` must be set in production, or any device on the internet
  can post punches.
- `PUNCH_API_KEY` must be set, or a random key is generated per process and
  changes on every cold start.
- `POST` bodies are capped at 64KB (`MAX_BODY_BYTES`), returning 413.
- Login is rate-limited on username **and** IP together, so nobody can lock a
  real user out from an arbitrary network.
