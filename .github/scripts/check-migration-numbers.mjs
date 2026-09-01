#!/usr/bin/env node
/**
 * Fail the build when a migration number is contested.
 *
 * `supabase_migrations.schema_migrations` keys on the NNNNN prefix alone. If
 * two files ever share a number, `db push` records the first, then reports
 * "up to date" for the second and skips it — no error, no warning. The columns
 * simply never exist, and the code that writes to them fails in production.
 *
 * CI already checked for duplicates *within a single tree*. That never fires,
 * because each branch only ever holds one file per number. The collisions that
 * actually happen here are cross-branch: two people pick the same next number
 * on the same afternoon, and whoever pushes second is silently dropped. That
 * is what this adds.
 *
 * Checks, in order of how much they cost to run:
 *
 *   1. duplicates within the working tree            (the original check)
 *   2. numbers this branch introduces that main already uses for a
 *      different file                                (lost the race, already merged)
 *   3. numbers this branch introduces that another remote branch also
 *      introduces                                    (racing right now)
 *
 * Only numbers this branch *introduces* are checked — a file already on main
 * is not this branch's problem, and the repo carries old cross-branch
 * collisions on long-dead branches that would otherwise fail every build.
 *
 * Usage:
 *   node .github/scripts/check-migration-numbers.mjs            # full check
 *   node .github/scripts/check-migration-numbers.mjs --local    # skip remote refs
 *
 * Requires refs for main and the other branches to be present; CI fetches
 * them. With --local, or when no remote refs exist, checks 2 and 3 are
 * skipped and the run says so rather than passing silently.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MIGRATIONS_DIR = "supabase/migrations";
const LOCAL_ONLY = process.argv.includes("--local");

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

/** "00511_foo.sql" -> "00511". Anything not NNNNN_*.sql is ignored. */
export function numberOf(filename) {
  const m = /^(\d{5})_.+\.sql$/.exec(filename);
  return m ? m[1] : null;
}

/** Group filenames by their number. Returns Map<number, Set<filename>>. */
export function byNumber(filenames) {
  const map = new Map();
  for (const f of filenames) {
    const n = numberOf(f);
    if (!n) continue;
    if (!map.has(n)) map.set(n, new Set());
    map.get(n).add(f);
  }
  return map;
}

/**
 * The core comparison, kept pure so it can be unit-tested without a git repo.
 *
 * `introduced` is what this branch adds; `claims` maps a number to the set of
 * {file, where} that already claim it elsewhere. A claim only conflicts when
 * the filename differs — the same file on two branches is just a shared
 * ancestor, not a collision.
 */
export function findConflicts(introduced, claims) {
  const conflicts = [];
  for (const { file, number } of introduced) {
    for (const claim of claims.get(number) ?? []) {
      if (claim.file !== file) conflicts.push({ number, ours: file, theirs: claim.file, where: claim.where });
    }
  }
  return conflicts;
}

/** "00511_foo_bar.sql" -> "foo_bar". The history table records this half. */
export function nameOf(filename) {
  const m = /^\d{5}_(.+)\.sql$/.exec(filename);
  return m ? m[1] : null;
}

/**
 * Compare what this branch introduces against what production has applied.
 * `applied` maps version -> recorded name (which may be null).
 *
 * An applied number is NOT automatically a conflict: migrations here are
 * routinely pushed to production from a feature branch before that branch
 * merges, so a branch legitimately owns an applied number. It is a conflict
 * only when the recorded name belongs to a different migration.
 *
 * When the recorded name is null the two cannot be told apart, so it is
 * reported as unverifiable rather than quietly passed — passing in silence is
 * the exact failure this whole check exists to prevent.
 */
export function findAppliedConflicts(introduced, applied) {
  const conflicts = [];
  const unverifiable = [];
  for (const { file, number } of introduced) {
    if (!applied.has(number)) continue;
    const recorded = applied.get(number);
    if (recorded == null || recorded === "") {
      unverifiable.push({ number, ours: file });
    } else if (recorded !== nameOf(file)) {
      conflicts.push({ number, ours: file, recorded });
    }
  }
  return { conflicts, unverifiable };
}

const listRef = (ref) => {
  const out = git("ls-tree", "--name-only", ref, `${MIGRATIONS_DIR}/`);
  return out ? out.trim().split("\n").filter(Boolean).map((p) => p.split("/").pop()) : null;
};

// Everything above is pure and safe to import. Everything below runs the check
// and ends in process.exit(1) on failure — so it must not execute when the unit
// tests import this module for its helpers, or one real collision anywhere in
// the repo takes the whole test suite down with it.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {

const fail = [];
const note = [];
let introducedForProdCheck = [];

// ── 1. Duplicates in this working tree ──────────────────────────────────────
const local = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
for (const [number, files] of byNumber(local)) {
  if (files.size > 1) {
    fail.push(`${number} is used by ${files.size} files in this branch: ${[...files].join(", ")}`);
  }
}

// ── 2 & 3. What does this branch introduce, and who else claims it? ─────────
const mainFiles = LOCAL_ONLY ? null : listRef("origin/main") ?? listRef("main");

if (!mainFiles) {
  note.push(LOCAL_ONLY
    ? "Skipped cross-branch checks (--local)."
    : "Could not read main — cross-branch checks skipped. Fetch main and re-run for full coverage.");
} else {
  const onMain = new Set(mainFiles);
  const introduced = local
    .filter((f) => !onMain.has(f))
    .map((f) => ({ file: f, number: numberOf(f) }))
    .filter((x) => x.number);

  introducedForProdCheck = introduced;

  if (introduced.length === 0) {
    note.push("This branch introduces no new migrations.");
  } else {
    note.push(`This branch introduces: ${introduced.map((i) => i.file).join(", ")}`);

    const claims = new Map();
    const addClaim = (file, where) => {
      const n = numberOf(file);
      if (!n) return;
      if (!claims.has(n)) claims.set(n, []);
      claims.get(n).push({ file, where });
    };

    for (const f of mainFiles) addClaim(f, "main");

    // Every other remote branch. A branch that merely carries the same file is
    // harmless; findConflicts only flags a differing filename.
    const branchesOut = git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin");
    const branches = (branchesOut ?? "").trim().split("\n").filter((b) => b && !b.endsWith("/HEAD"));
    let scanned = 0;
    for (const b of branches) {
      if (b === "origin/main") continue;
      const files = listRef(b);
      if (!files) continue;
      scanned++;
      // Only count what that branch introduces relative to main, for the same
      // reason as above: shared history is not a claim.
      for (const f of files) if (!onMain.has(f)) addClaim(f, b);
    }
    note.push(`Compared against main + ${scanned} remote branch(es).`);

    for (const c of findConflicts(introduced, claims)) {
      fail.push(
        `${c.number} is contested: this branch has ${c.ours}, but ${c.where} has ${c.theirs}. ` +
        `Renumber whichever has NOT been applied yet.`,
      );
    }
  }
}

// ── 4. Numbers already burnt in production ─────────────────────────────────
// Checks 2 and 3 answer "is anyone else holding this number". They cannot
// answer "has this number already been used", and the two differ here:
// migrations get pushed to production straight from feature branches, so a
// number can sit in schema_migrations while the branch that put it there was
// abandoned and its file never reached git at all. To a git-only check that
// number looks free, and db push will silently skip whoever claims it next.
//
// Credentials are optional. Their absence is reported rather than passed over
// quietly — a check that silently does nothing is worse than no check, because
// it reads as a green tick. Accepts either a full connection URI
// (SUPABASE_DB_URL) or the BACKUP_DB_* parts this repo already uses.
async function appliedVersions() {
  // Trailing newlines on pasted secrets have broken this repo's database
  // config before; strip them rather than fail with an opaque DNS error.
  const env = (k) => (process.env[k] ?? "").trim();

  const url = env("SUPABASE_DB_URL");
  const host = env("BACKUP_DB_HOST");
  if (!url && !(host && env("BACKUP_DB_USER") && env("BACKUP_DB_PASSWORD"))) return null;

  const { default: pg } = await import("pg");
  const client = new pg.Client(
    url
      ? { connectionString: url, ssl: { rejectUnauthorized: false } }
      : {
          host,
          port: parseInt(env("BACKUP_DB_PORT") || "5432", 10),
          user: env("BACKUP_DB_USER"),
          password: env("BACKUP_DB_PASSWORD"),
          database: env("BACKUP_DB_NAME") || "postgres",
          ssl: { rejectUnauthorized: false },
        },
  );
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT version, name FROM supabase_migrations.schema_migrations",
    );
    return new Map(rows.map((r) => [String(r.version), r.name ?? null]));
  } finally {
    await client.end();
  }
}

if (introducedForProdCheck.length > 0) {
  let applied = null;
  try {
    applied = await appliedVersions();
  } catch (err) {
    // A credential or permission problem must never read as "no conflicts".
    fail.push(`could not read production migration history: ${err.message}`);
  }

  if (applied) {
    note.push(`Production has ${applied.size} applied migration(s).`);
    const { conflicts, unverifiable } = findAppliedConflicts(introducedForProdCheck, applied);
    for (const c of conflicts) {
      fail.push(
        `${c.number} is already applied in production as "${c.recorded}", but this branch ` +
        `has ${c.ours}. That number is spent — db push will skip this file silently.`,
      );
    }
    for (const u of unverifiable) {
      fail.push(
        `${u.number} is already applied in production and the history row records no name, ` +
        `so it cannot be confirmed as ${u.ours}. Verify by hand before merging.`,
      );
    }
  } else if (fail.length === 0) {
    note.push(
      "Production history NOT checked — no database credentials in the environment. " +
      "Set SUPABASE_DB_URL (or BACKUP_DB_*) to also catch numbers burnt by an abandoned branch.",
    );
  }
}

for (const n of note) console.log(`   ${n}`);

if (fail.length > 0) {
  console.error("\n❌ Migration number conflict\n");
  for (const f of fail) console.error(`   ${f}`);
  console.error(
    "\n   supabase db push keys on the NNNNN prefix alone. It records the first file\n" +
    "   to claim a number and silently skips every later one — no error, the columns\n" +
    "   just never get created and production breaks when code writes to them.\n\n" +
    "   Pick the next number that is free across main AND every open branch, and\n" +
    "   re-check right before merging: this is a race, and it can be lost between\n" +
    "   opening a PR and landing it.\n",
  );
  process.exit(1);
}

console.log("\n✅ No migration number conflicts");

}
