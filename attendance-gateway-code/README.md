# Attendance Gateway

Employee attendance for The WorkVilla: biometric-device punches, self-service
punch in/out, leave / permission / correction / overtime / field-trip workflows,
and admin reporting.

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

## For contributors

You do not need any cloud credentials to work on this app. Develop against a
local SQLite file instead of Turso — the libSQL client reads it the same way.

```bash
git checkout main && git pull
git checkout -b fix/<short-description>
cd attendance-gateway-code
cp .env.example .env
```

Then edit `.env`:

```bash
TURSO_DATABASE_URL=file:attendance.db   # local file, already git-ignored
TURSO_AUTH_TOKEN=                       # leave empty for a local file
SEED_DEMO_DATA=true                     # demo logins, local only
```

```bash
npm install
npm start    # http://localhost:3001 — admin / admin123 (forces a password change)
npm test     # must pass before opening a PR
```

Delete `attendance.db` to start over from a clean schema.

Ground rules:

- **Never ask for or use the production Turso credentials.** Everything can be
  reproduced locally; production holds real employee data.
- **Never set `SEED_DEMO_DATA` on a deployed environment** — its passwords are
  published right here.
- **Keep this app isolated from the CRM.** No imports from `../src`, no Supabase
  client, no links to the CRM's `/attendance` routes.
- Every change goes through a PR into `main`; the repo owner reviews and merges.
  A failing `Vercel – twv-attendance` check on your PR is expected if you are
  not on the Vercel team — only `lint-and-build` is required.
- Put pure computation in `attendance-logic.js` with a test in `test/`; that is
  the only unit-tested part of the app, so click through anything in `server.js`
  in the browser before opening the PR.

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

A day closed only by that auto-checkout is a **Missed Checkout** (MC): it counts as
a Half Day, with hours counted up to the shift end, until the employee files a
correction at `/corrections` and an admin or manager approves it. Each employee
gets 2 check-in/check-out corrections a month (pending and approved count); past
that, an approved correction fixes the times but the day stays a Half Day. They
also get 1 full-day correction a month for a day with no punches at all; any
other such day stays Absent. The limits live in `attendance-logic.js`.

## Configuration

Operational settings live in the database, editable by an admin at
**/admin/settings** — office public IPs, the biometric device serial, the device
clock correction, the punch API key, the LocationIQ key, and address-search
biasing. Each resolves in this order:

1. the `app_settings` table (the admin UI)
2. the environment variable of the same name (a deploy-time default)
3. a built-in fallback

Changes take effect within about 30 seconds, without a redeploy. The page shows
which of the three each value is actually coming from, because the most confusing
failure mode is a setting that looks right in the UI while an environment
variable of the same name is what the app is really using.

Three things stay environment-only by necessity: `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` (needed to read the settings table at all), `CRON_SECRET` (it
guards a route with no logged-in admin to fix a mistake), and
`ADMIN_BOOTSTRAP_PASSWORD` (used before any admin account exists).

Secrets are never rendered back into the page. Saving with a secret field left
blank keeps the stored value, so editing an unrelated setting cannot wipe a key;
clearing one is an explicit checkbox.

## Security notes

- `/iclock/*` is authenticated **only** by the device serial number in the query
  string, so it **fails closed**: while no serial is configured those routes reject
  every push, rather than accepting any device on the internet.
- `PUNCH_API_KEY` falls back to a random per-process key when unset, which changes
  on every cold start — unusable by a device, but not guessable by anyone else.
- `POST` bodies are capped at 64KB (`MAX_BODY_BYTES`), returning 413.
- Login is rate-limited on username **and** IP together, so nobody can lock a
  real user out from an arbitrary network.
