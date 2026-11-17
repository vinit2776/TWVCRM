#!/usr/bin/env node
/**
 * Seeds the STAGING Supabase project with a fake OneGrid meter and ~36 days of 15-minute
 * energy readings for the "Perungudi - OMR (staging test)" location, so the Energy Alerts
 * screen has a real baseline to compare against. The last ~2 hours run well above usual,
 * so a rule has something to find.
 *
 * Run with:
 *   node scripts/seed-staging-energy.mjs           # (re)seed, idempotent; spike = last 8 slots
 *   node scripts/seed-staging-energy.mjs --no-spike # normal readings only
 *   node scripts/seed-staging-energy.mjs --clear    # remove the fake meter's readings + alert rows
 *
 * Reads .env.staging.local (a different file from .env.local on purpose) and refuses to run
 * against the production project. The API key it stores is a placeholder: nothing can reach
 * OneGrid with it, and the hourly capture only runs on production.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const PRODUCTION_REF = "zlbvadtajetylacxevsm";
const LOCATION_NAME = "Perungudi - OMR (staging test)";
const DEVICE_ID = "STG-DEMO-METER";
const DAYS = 36;
const SLOT_MS = 15 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(new URL(path, import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) { let v = m[2].trim(); if (/^["'].*["']$/.test(v)) v = v.slice(1, -1); env[m[1]] = v.replace(/\\n$/, ""); }
  }
  return env;
}
const env = loadEnv("../.env.staging.local");
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error("Missing Supabase env in .env.staging.local"); process.exit(1); }
if (env.NEXT_PUBLIC_SUPABASE_URL.includes(PRODUCTION_REF)) { console.error("Refusing to run: this is the PRODUCTION project."); process.exit(1); }
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: loc } = await supa.from("locations").select("id").eq("name", LOCATION_NAME).maybeSingle();
if (!loc) { console.error(`Location "${LOCATION_NAME}" not found on staging.`); process.exit(1); }

if (process.argv.includes("--clear")) {
  await supa.from("location_energy_readings").delete().eq("location_id", loc.id).eq("device_id", DEVICE_ID);
  await supa.from("energy_alert_rules").delete().eq("location_id", loc.id);
  await supa.from("location_electricity_config").update({ onegrid_enabled: false, onegrid_api_key: null, onegrid_default_device_id: null }).eq("location_id", loc.id);
  console.log("Cleared the fake meter, its readings and this location's alert rules.");
  process.exit(0);
}

const cfg = { onegrid_enabled: true, onegrid_api_key: "staging-placeholder-not-a-real-key", onegrid_default_device_id: DEVICE_ID };
const { data: existing } = await supa.from("location_electricity_config").select("id").eq("location_id", loc.id).maybeSingle();
const { error: cfgErr } = existing
  ? await supa.from("location_electricity_config").update(cfg).eq("location_id", loc.id)
  : await supa.from("location_electricity_config").insert({ location_id: loc.id, ...cfg });
if (cfgErr) { console.error("Could not set the meter on the location:", cfgErr.message); process.exit(1); }

// A working-day kW curve: night base load, a daytime hump. Saturdays 60%, Sundays 25%.
const kwAt = (tsMs) => {
  const d = new Date(tsMs + IST);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const dow = d.getUTCDay();
  const scale = dow === 0 ? 0.25 : dow === 6 ? 0.6 : 1;
  const hump = h > 8 && h < 20 ? 28 * Math.sin(Math.PI * (h - 8) / 12) : 0;
  const wobble = 1 + 0.025 * Math.sin(tsMs / SLOT_MS * 1.7) + 0.015 * Math.cos(tsMs / SLOT_MS * 0.37);
  return (6 + hump * scale) * wobble;
};

const lastSlot = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
const first = lastSlot - DAYS * 96 * SLOT_MS;
const spike = !process.argv.includes("--no-spike");
const rows = [];
let cum = 1_000_000;
for (let ts = first; ts <= lastSlot; ts += SLOT_MS) {
  let kw = kwAt(ts);
  if (spike && ts > lastSlot - 8 * SLOT_MS) kw *= 1.22;
  const wh = kw * 1000 * 0.25;
  cum += wh;
  rows.push({ location_id: loc.id, device_id: DEVICE_ID, ts: new Date(ts).toISOString(), energy_delta_wh: Math.round(wh), cumulative_wh: Math.round(cum) });
}
for (let i = 0; i < rows.length; i += 500) {
  const { error } = await supa.from("location_energy_readings").upsert(rows.slice(i, i + 500), { onConflict: "location_id,device_id,ts" });
  if (error) { console.error("Insert failed:", error.message); process.exit(1); }
}
console.log(`Seeded ${rows.length} readings for ${LOCATION_NAME} (${DEVICE_ID}); spike ${spike ? "on (last 2h, +22%)" : "off"}.`);
