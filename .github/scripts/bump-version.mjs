/**
 * Bumps the patch version in package.json and package-lock.json, and prints
 * the new version to stdout (nothing else — the workflow captures it).
 *
 * A file rather than an inline `node -e` in the workflow for two reasons: the
 * retry loop needs to re-run it after resetting to a moved main, and the
 * inline form required escaping backticks inside a double-quoted shell string,
 * where getting it wrong means bash silently executes the backticked text
 * instead of passing it to node.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const parts = pkg.version.split(".");
// Support both 3-digit (1.0.90) and 4-digit (1.0.90.0) versioning.
parts[parts.length - 1] = String(parseInt(parts[parts.length - 1], 10) + 1);
pkg.version = parts.join(".");
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

// Keep package-lock.json in step. This bumps by hand rather than running
// `npm version`, so without this the lockfile fell one version further behind
// on every push — making its version field useless as a deploy marker and
// producing a spurious diff for anyone who ran `npm install`. npm records the
// version in two places.
const lockPath = "package-lock.json";
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.version = pkg.version;
  if (lock.packages && lock.packages[""]) {
    lock.packages[""].version = pkg.version;
  }
  // Same shape npm itself writes, so this only ever touches the two version
  // lines and never reformats the file.
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

process.stdout.write(pkg.version);
