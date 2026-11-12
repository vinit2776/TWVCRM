#!/usr/bin/env node
/**
 * Adds role-specific test users to the STAGING Supabase project so permission
 * paths can be exercised (for example the accounts role paying an exit refund
 * that an admin approved). Idempotent: re-running leaves existing users alone
 * and re-asserts their role.
 *
 *   node scripts/seed-staging-users.mjs
 *
 * Reads .env.staging.local (never .env.local) and refuses to run against the
 * production project. Addresses use the reserved .test domain, so nothing can
 * reach a real inbox. The logins are printed here, the same way
 * scripts/seed-staging.mjs does for the staging admin.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const PRODUCTION_REF = "zlbvadtajetylacxevsm";

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(new URL(path, import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[m[1]] = v.replace(/\\n$/, "");
    }
  }
  return env;
}

const env = loadEnv("../.env.staging.local");
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error("Missing Supabase env in .env.staging.local"); process.exit(1); }
if (env.NEXT_PUBLIC_SUPABASE_URL.includes(PRODUCTION_REF)) { console.error("Refusing to run: this points at PRODUCTION."); process.exit(1); }
console.log(`Seeding users on ${env.NEXT_PUBLIC_SUPABASE_URL} ...`);
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const USERS = [
  { email: "accounts@staging.theworkvilla.test", password: "StagingAccounts!2026", full_name: "Staging Accounts", role: "accounts" },
];

for (const u of USERS) {
  const { data: list } = await supa.auth.admin.listUsers({ perPage: 1000 });
  let authUser = list?.users?.find((x) => x.email === u.email);
  if (!authUser) {
    const { data, error } = await supa.auth.admin.createUser({
      email: u.email, password: u.password, email_confirm: true, user_metadata: { full_name: u.full_name },
    });
    if (error) throw error;
    authUser = data.user;
    console.log(`Created auth user ${u.email}`);
  } else {
    console.log(`Auth user ${u.email} already exists`);
  }

  // The on_auth_user_created trigger inserts the public.users row (default role sales_rep); set the role.
  const { data: updated, error: upErr } = await supa
    .from("users").update({ role: u.role, full_name: u.full_name, is_active: true })
    .eq("auth_id", authUser.id).select("id").maybeSingle();
  if (upErr) throw upErr;
  if (!updated) {
    const { error: insErr } = await supa.from("users").insert({ auth_id: authUser.id, email: u.email, full_name: u.full_name, role: u.role, is_active: true });
    if (insErr) throw insErr;
  }
  console.log(`Login: ${u.email} / ${u.password}  (role: ${u.role})`);
}
console.log("Done.");
