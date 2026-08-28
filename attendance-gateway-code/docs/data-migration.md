# Migrating the office `attendance.db` into Turso

The office Windows machine has been running the standalone app against a local
SQLite file. That file is the only copy of the real punch history, so it has to
come across intact before the local service is retired.

Everything below runs from a Mac with Node 22+ and the Turso CLI. Nothing needs
to be installed on the Windows machine — `attendance.db` is just a file, so the
migration is a copy, not an export.

## How this fits the launch plan

Decided 2026-08-28: **the office app keeps running as the system of record, and
the migration happens at cutover, not at launch.** The cloud app goes up first
against an empty database so login and the leave / permission / overtime flows
can be shaken out, while the biometric device keeps pushing to the office LAN app
exactly as it does today.

That ordering has one consequence that will cost you real data if it is missed:

> **The cloud instance is throwaway until cutover.** Do not register real
> employees, approve real leave, or record real punches in it. At cutover the
> office database is imported into a *brand new* Turso database which then
> replaces the shakeout one — and anything entered into the shakeout database is
> discarded with it.

The reason it replaces rather than merges: `turso db create --from-file` builds a
new database from the file, and merging the two instead would mean reconciling
`AUTOINCREMENT` primary keys across `punches`, `leave_requests`,
`permission_requests`, `overtime_requests` and `field_trips`, where the office
file and the cloud database will have assigned the same ids to different rows.
Replacing is an env-var swap; merging is a bespoke reconciliation with no safe
automatic answer.

So the launch database gets `ADMIN_BOOTSTRAP_PASSWORD` (an empty database, so
that path fires and no seed credentials ever exist), and the cutover database
gets the credential rotation in step 5 instead (an imported database, which
carries the old seeds).

## Before you start

**Use a direct turso.tech account rather than the Vercel Marketplace
integration.** The marketplace flow provisions an empty database with no
supported path for importing an existing SQLite file; a directly-created account
gets the Turso Cloud dashboard, which imports one directly.

The account is `vinitv` on the Free plan, created 2026-08-28.

The dashboard's **Create Database → Upload SQLite File** is the primary import
route and needs no tooling at all. Its **Export Database → Download SQLite File**
is the reverse, which is worth knowing as a backup path once the app is live.

The CLI is optional, and only worth installing if you prefer the commands to the
UI. On macOS it is behind Homebrew's third-party tap trust check:

```bash
brew tap libsql/sqld
brew trust --formula libsql/sqld/sqld
brew install tursodatabase/tap/turso
turso auth login
```

Every `turso db` command below has a dashboard equivalent; the CLI form is given
because it is easier to write down exactly.

**Leave the "Run this database on TursoDB, the Rust rewrite of SQLite" toggle
off.** The app talks classic libSQL through `@libsql/client`, and that engine is
a separate beta with different behaviour.

**Turn on Delete Protection** for the live database once it holds the real punch
history — it is a per-database toggle in the dashboard's Configuration section.

## 1. Take the file off the office machine

Stop the service first. A running SQLite database can have uncommitted pages
sitting in a `-wal` sidecar file; stopping the service checkpoints them back into
the main file, so a copy taken while it runs can be missing the most recent
punches.

```
:: Administrator command prompt, on the office machine
"C:\nssm-2.24\nssm-2.24\win64\nssm.exe" stop AttendanceGateway
```

Then copy `attendance.db` off the machine. If `attendance.db-wal` or
`attendance.db-shm` are still present next to it after the stop, copy those too —
their presence means the shutdown did not checkpoint cleanly.

**The device is not affected by this.** The K40 Pro buffers punches internally and
only clears a record once something has accepted it, so it holds everything from
the moment the service stops until the relay is running. Nothing is lost in the
gap; do not clear the device's logs during cutover.

## 2. Fingerprint the file before importing

```bash
cd attendance-gateway-code
npm install
node scripts/db-snapshot.js --file ~/Desktop/attendance.db > /tmp/before.json
```

This records the columns, row count, and a content hash of every table.

## 3. Create the cutover database from the file

A **new** database, alongside the shakeout `twv-attendance-staging` — not a
modification of it. Name it distinctly so the two can never be confused in the
Vercel settings, and put it in the same region (AWS AP South / Mumbai), which is
what `vercel.json`'s `regions: ["bom1"]` pairs the functions with.

In the dashboard: **Create Database → Upload SQLite File**, then create a token
from the database's Connect panel.

Or by CLI:

```bash
turso db create twv-attendance-live --from-file ~/Desktop/attendance.db
turso db show twv-attendance-live --url
turso db tokens create twv-attendance-live
```

Keep the URL and token. They replace `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` in the Vercel project at step 5b — *after* the verification
and rotation below, so the app is never briefly serving the imported database
with its old seed credentials still live.

Leave the shakeout database in place until the cutover is confirmed good. It
costs nothing and is a second rollback option.

## 4. Prove the import was faithful — before anything touches the app

```bash
export TURSO_DATABASE_URL='libsql://...'
export TURSO_AUTH_TOKEN='...'
node scripts/db-snapshot.js --turso > /tmp/after.json
diff /tmp/before.json /tmp/after.json && echo "identical"
```

**Order matters here.** `init()` runs its `ALTER TABLE` migrations on the first
request the deployed app ever serves, adding columns the office database predates
(`designation`, `branch`, `language`, `field_trips.status`, and others). Those new
columns change every table hash, so a snapshot taken after the app has been hit
can no longer be compared against the original file. Do this diff *before* the
Vercel project is pointed at this database.

If you do miss the window, row counts are still comparable even though the hashes
are not — a mismatch in `columns` alone, with identical `rows`, is the migration
having run and is expected.

`sessions` and `login_attempts` are counted but not hashed: the sessions were
issued by the old LAN app against a different host and get cleared anyway, and
login attempts are rate-limiting scratch data.

## 5. Rotate the inherited credentials — before the app is pointed at it

This is the step that matters most, and it is easy to skip because the app looks
finished without it.

The office database was created by the old first-run seed, so it almost certainly
still contains `admin` / `admin123` and `EMP-001` .. `EMP-005` / `password123`.
Gating the seed behind `SEED_DEMO_DATA` stops *new* databases getting those
accounts; it does nothing about a database that already has them.
`ADMIN_BOOTSTRAP_PASSWORD` cannot help either — it only fires when the `users`
table is completely empty, which this one is not.

Audit what came across:

```bash
turso db shell twv-attendance-live \
  "SELECT username, role, employee_id, must_change_password FROM users ORDER BY role, username"
```

Rotate the admin account, and any account still on a seed password:

```bash
node scripts/set-password.js admin '<a long password only you know>'
```

That sets the password, forces a change at next login, and revokes any session
the account already had. Then clear the inherited sessions wholesale, since they
were minted by the old deployment:

```bash
turso db shell twv-attendance-live "DELETE FROM sessions"
```

Delete the demo employees once you have confirmed they hold no real punches:

```bash
turso db shell twv-attendance-live \
  "SELECT employee_id, COUNT(*) FROM punches WHERE employee_id LIKE 'EMP-00%' GROUP BY employee_id"
```

### 5b. Point the app at the imported database

Only now, with the data verified and the inherited credentials rotated, swap the
Vercel project's `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to the values from
step 3 and redeploy. Doing it in this order means the app is never serving the
imported database while `admin`/`admin123` still works on it.

Also remove `ADMIN_BOOTSTRAP_PASSWORD` if it is still set — it was for the empty
shakeout database and does nothing against an imported one.

Log in once against the new database and confirm the punch history is there
before touching the office machine again.

## 6. Cut the device over

With the data in place and the credentials rotated, follow
[relay/README.md](../relay/README.md): install the relay as a service pointing at
`https://attendance.theworkvilla.com`, stop/remove the old `AttendanceGateway`
service to free port 3001, and start the relay. The device itself needs no
reconfiguration — it keeps pushing to the same LAN IP and port.

The buffered punches from the freeze window flush automatically on the device's
next push.

## Rollback

Keep the original `attendance.db` untouched as the rollback artifact — copy it,
do not move it. Because the office app runs right up to the cutover, rolling back
is genuinely cheap:

1. Stop the relay service on the office machine.
2. Restart the `AttendanceGateway` service, which retakes port 3001.
3. The device is still pointed at the same LAN IP and port, so it resumes pushing
   to the local app with no reconfiguration, and flushes anything it buffered.

The office database is untouched by the migration (it was copied, not moved), so
this restores the previous setup exactly. The only loss is punches recorded into
Turso after the swap, which would need re-entering by hand — the argument for
keeping the window between step 5b and step 6 short, and for doing the cutover
outside working hours.
