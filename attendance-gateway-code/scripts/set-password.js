'use strict';

// Sets a user's password directly against the Turso database, and forces a change
// at their next login.
//
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
//     node scripts/set-password.js admin '<new password>'
//
// This exists for cutover. The database migrated from the office machine was
// created by the old first-run seed, so it already contains "admin"/"admin123"
// and EMP-001..5/"password123". ADMIN_BOOTSTRAP_PASSWORD cannot help there — it
// only fires when the users table is completely empty — so those credentials have
// to be rotated out of band before the app is reachable from the internet.
//
// Also useful afterwards for resetting an employee who is locked out.

const crypto = require('crypto');
const { createClient } = require('@libsql/client');

// Must stay identical to hashPassword() in server.js — scrypt with a per-user
// 16-byte salt, 64-byte key, stored as "salt:hash". Duplicated rather than
// imported because requiring server.js would boot the whole application.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error("Usage: node scripts/set-password.js <username> '<new password>'");
    process.exit(2);
  }
  if (password.length < 12) {
    console.error('Refusing to set a password shorter than 12 characters.');
    process.exit(2);
  }
  if (!process.env.TURSO_DATABASE_URL) {
    console.error('TURSO_DATABASE_URL is not set.');
    process.exit(2);
  }

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const existing = await client.execute({
    sql: 'SELECT id FROM users WHERE username = ?',
    args: [username],
  });
  if (existing.rows.length === 0) {
    console.error(`No user named "${username}".`);
    process.exit(1);
  }

  // must_change_password = 1 so this password is only ever a handover credential,
  // never the one the account keeps.
  await client.execute({
    sql: 'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE username = ?',
    args: [hashPassword(password), username],
  });
  // Any session issued against the old password is revoked, so a rotation actually
  // ends access rather than leaving an already-signed-in attacker in place.
  const killed = await client.execute({
    sql: 'DELETE FROM sessions WHERE username = ?',
    args: [username],
  });

  console.log(`Password set for "${username}". They must change it at next login.`);
  console.log(`Revoked ${Number(killed.rowsAffected)} active session(s).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
