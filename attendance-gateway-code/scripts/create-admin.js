'use strict';

// Creates the first admin account directly against the database.
//
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
//     node scripts/create-admin.js admin '<password>'
//
// (With a .env file present, `npm run create-admin -- admin '<password>'` picks it
// up automatically.)
//
// This is an alternative to the ADMIN_BOOTSTRAP_PASSWORD environment variable,
// for when setting that variable is inconvenient — it does the same thing, from a
// machine that can reach the database, and needs nothing configured on the host.
//
// Same guard as the bootstrap path: it refuses to run unless the users table is
// completely empty, so it can never mint a second admin on a database that is
// already in use, and can never be used to quietly add an account to a live system.
// To reset a password on an existing account, use set-password.js instead.

const crypto = require('crypto');
const { createClient } = require('@libsql/client');

// Must stay identical to hashPassword() in server.js — scrypt with a per-user
// 16-byte salt, 64-byte key, stored as "salt:hash".
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function formatTimestamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
         `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error("Usage: node scripts/create-admin.js <username> '<password>'");
    process.exit(2);
  }
  if (password.length < 12) {
    console.error('Refusing to set a password shorter than 12 characters.');
    process.exit(2);
  }
  if (!process.env.TURSO_DATABASE_URL) {
    console.error('TURSO_DATABASE_URL is not set. Put it in .env, or pass it inline.');
    process.exit(2);
  }

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  // The table only exists once the deployed app has served one request (init()
  // creates the schema). Say so plainly rather than failing with a raw SQL error.
  try {
    await client.execute('SELECT 1 FROM users LIMIT 1');
  } catch {
    console.error('No "users" table yet. Open the deployed app once so it can create');
    console.error('the schema, then run this again.');
    process.exit(1);
  }

  const count = Number((await client.execute('SELECT COUNT(*) AS c FROM users')).rows[0].c);
  if (count > 0) {
    console.error(`Refusing to run: the users table already has ${count} account(s).`);
    console.error('Use scripts/set-password.js to reset an existing account instead.');
    process.exit(1);
  }

  // must_change_password = 1 so this is a handover credential, never the one the
  // account keeps — the same contract as ADMIN_BOOTSTRAP_PASSWORD.
  await client.execute({
    sql: 'INSERT INTO users (username, password_hash, role, employee_id, must_change_password) VALUES (?, ?, ?, ?, 1)',
    args: [username, hashPassword(password), 'admin', null],
  });
  await client.execute({
    sql: 'INSERT INTO admin_audit_log (actor_username, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [username, 'admin_bootstrapped', 'users', username, 'created via scripts/create-admin.js', formatTimestamp(new Date())],
  });

  console.log(`Created admin "${username}". Log in with it once; the app will make you`);
  console.log('choose a new password immediately.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
