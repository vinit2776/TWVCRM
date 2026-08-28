# Migrating the office `attendance.db` into Turso

The office Windows machine has been running the standalone app against a local
SQLite file. That file is the only copy of the real punch history, so it has to
come across intact before the local service is retired.

Everything below runs from a Mac with Node 22+ and the Turso CLI. Nothing needs
to be installed on the Windows machine — `attendance.db` is just a file, so the
migration is a copy, not an export.

## Before you start

**Use a direct turso.tech account rather than the Vercel Marketplace integration
for this database.** The marketplace flow provisions an empty database, and there
is no supported way to import an existing SQLite file into one from the CLI. A
directly-created database can be built *from* the file in a single command, which
is the difference between a one-line import and hand-replaying a SQL dump.

```bash
brew install tursodatabase/tap/turso
turso auth login
```

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

## 3. Create the Turso database from the file

```bash
turso db create twv-attendance --from-file ~/Desktop/attendance.db
turso db show twv-attendance --url
turso db tokens create twv-attendance
```

Keep the URL and token — they become `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN`.

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

## 5. Rotate the inherited credentials — do this before DNS

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
turso db shell twv-attendance \
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
turso db shell twv-attendance "DELETE FROM sessions"
```

Delete the demo employees once you have confirmed they hold no real punches:

```bash
turso db shell twv-attendance \
  "SELECT employee_id, COUNT(*) FROM punches WHERE employee_id LIKE 'EMP-00%' GROUP BY employee_id"
```

Only after this should `attendance.theworkvilla.com` resolve to the app.

## 6. Cut the device over

With the data in place and the credentials rotated, follow
[relay/README.md](../relay/README.md): install the relay as a service pointing at
`https://attendance.theworkvilla.com`, stop/remove the old `AttendanceGateway`
service to free port 3001, and start the relay. The device itself needs no
reconfiguration — it keeps pushing to the same LAN IP and port.

The buffered punches from the freeze window flush automatically on the device's
next push.

## Rollback

Keep the original `attendance.db` untouched as the rollback artifact. Restarting
the `AttendanceGateway` service on the office machine restores the previous setup
exactly, since the device is still pointed at the same address. Punches recorded
into Turso during the cloud window would need re-entering by hand, which is the
argument for keeping the cutover window short.
