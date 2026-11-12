'use strict';

// Fingerprints an attendance database so a migration can be proved faithful.
//
// Run it against the old office SQLite file and again against the imported Turso
// database, then diff the two JSON outputs. Identical output means every row of
// every table survived the import unchanged.
//
//   node scripts/db-snapshot.js --file ./attendance.db > before.json
//   node scripts/db-snapshot.js --turso                > after.json
//   diff before.json after.json
//
// --turso reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from the environment.
//
// The per-table hash covers the full contents, not just the row count, so a
// truncated or partially-imported table is caught. Values are normalised to
// strings first because the two drivers disagree about integer representation
// (node:sqlite returns number, libSQL can return BigInt) — without that, an
// identical row would hash differently on each side and every table would look
// broken.

const crypto = require('crypto');

// Field separators that cannot occur in this schema's text, so "ab" + "c" can
// never collide with "a" + "bc".
const FIELD_SEP = '\x1f';
const ROW_SEP = '\x1e';

// Tables whose contents are expected to differ across the migration by design —
// counted, but not hashed, so a legitimate difference doesn't mask a real one.
// `sessions` are cleared at cutover (they were issued by the old LAN app and are
// worthless against the new host); `login_attempts` is a rate-limiting scratch
// table, not a record anyone needs to keep.
const VOLATILE_TABLES = new Set(['sessions', 'login_attempts']);

function normalise(value) {
  if (value === null || value === undefined) return '\\0'; // distinct from the string "null"
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return String(value);
}

function hashRows(rows, columns) {
  const h = crypto.createHash('sha256');
  for (const row of rows) {
    // Index by column name in a fixed order — the drivers do not guarantee the
    // same key order on the objects they return.
    h.update(columns.map((c) => normalise(row[c])).join(FIELD_SEP));
    h.update(ROW_SEP);
  }
  return h.digest('hex').slice(0, 16);
}

async function snapshot(read) {
  const tables = (await read(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )).map((r) => r.name);

  const out = {};
  for (const table of tables) {
    // Sorted so that a column init() adds on the new side shows up as a visible
    // schema difference rather than a silent hash mismatch with no explanation.
    const columns = (await read(`PRAGMA table_info(${table})`)).map((r) => r.name).sort();
    // Order by every column rather than by rowid: AUTOINCREMENT ids survive a
    // faithful import, but ordering on content makes the hash independent of that.
    const orderBy = columns.map((c) => `"${c}"`).join(', ');
    const rows = await read(`SELECT * FROM "${table}" ORDER BY ${orderBy}`);
    out[table] = {
      columns,
      rows: rows.length,
      hash: VOLATILE_TABLES.has(table) ? '(volatile - not hashed)' : hashRows(rows, columns),
    };
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');

  let read;
  let source;
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const { DatabaseSync } = require('node:sqlite'); // Node 22.5+
    const file = args[fileIdx + 1];
    const db = new DatabaseSync(file, { readOnly: true });
    read = async (sql) => db.prepare(sql).all();
    source = `file:${file}`;
  } else if (args.includes('--turso')) {
    const { createClient } = require('@libsql/client');
    if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is not set');
    const client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    read = async (sql) => (await client.execute(sql)).rows;
    source = 'turso';
  } else {
    console.error('Usage: node scripts/db-snapshot.js --file <path/to/attendance.db>');
    console.error('       node scripts/db-snapshot.js --turso');
    process.exit(2);
  }

  const tables = await snapshot(read);
  // The source label goes to stderr, not into the JSON body: the two snapshots
  // must diff to nothing, and the whole point is that they came from different places.
  console.error(`snapshot source: ${source}`);
  console.log(JSON.stringify(tables, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
