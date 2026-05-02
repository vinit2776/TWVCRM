#!/usr/bin/env node
/**
 * Seed demo facility issues + assets so the IT team has data to play with
 * during onboarding and to validate every screen / flow.
 *
 * Run with:
 *   node scripts/seed-facility-demo.mjs
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Bypasses RLS via the service role key — only meant for local / staging seeding.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

// ── tiny .env.local loader (no extra dep) ──────────────────────────────────
const env = {};
try {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) {
      let v = m[2].trim();
      // Strip surrounding quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      // Strip literal "\n" that some editors add
      v = v.replace(/\\n$/, "");
      env[m[1]] = v;
    }
  }
} catch {
  console.error(".env.local not found");
  process.exit(1);
}
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing SUPABASE_URL or SERVICE_ROLE in .env.local");
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── data fetch helpers ─────────────────────────────────────────────────────
async function pickActorId() {
  const { data, error } = await supa
    .from("users")
    .select("id, full_name, role")
    .eq("is_active", true)
    .eq("role", "admin")
    .limit(1);
  if (error) { console.error("pickActorId error:", error); throw error; }
  if (!data || data.length === 0) throw new Error("No admin user found");
  return data[0];
}

async function listLocations() {
  const { data } = await supa
    .from("locations")
    .select("id, name, code")
    .eq("is_active", true)
    .order("name", { ascending: true })
    .limit(4);
  if (!data || data.length === 0) throw new Error("No active locations");
  return data;
}

async function listCategories() {
  const { data } = await supa
    .from("facility_asset_categories")
    .select("id, name, slug, default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs")
    .eq("scope", "it")
    .eq("is_active", true);
  return data || [];
}

// ── seed assets (1-3 per category per location, idempotent by asset_code) ──
async function seedAssets(locations, categories, actor) {
  const assetSlugFocus = ["it-udm-router", "it-wifi-ap", "it-switch", "it-isp", "it-printer", "it-cctv"];
  const focusCats = categories.filter((c) => assetSlugFocus.includes(c.slug));
  const created = [];
  for (const loc of locations) {
    const locPrefix = (loc.name.replace(/[^A-Z]/gi, "").slice(0, 3) || loc.code.slice(0, 3)).toUpperCase();
    for (const cat of focusCats) {
      const catShort = cat.slug.split("-").pop().toUpperCase().slice(0, 4);
      const count = cat.slug === "it-wifi-ap" ? 3 : cat.slug === "it-switch" ? 2 : 1;
      for (let i = 1; i <= count; i++) {
        const code = `${locPrefix}-${catShort}-${String(i).padStart(3, "0")}`;
        const { data: existing } = await supa
          .from("facility_assets")
          .select("id")
          .eq("location_id", loc.id)
          .eq("asset_code", code)
          .maybeSingle();
        if (existing) { created.push({ id: existing.id, location_id: loc.id, category_id: cat.id, asset_code: code }); continue; }

        const name = cat.slug === "it-wifi-ap"
          ? `WiFi AP ${i} — ${loc.name}`
          : cat.slug === "it-switch"
            ? `Switch ${i} — ${loc.name}`
            : `${cat.name} — ${loc.name}`;

        const { data, error } = await supa
          .from("facility_assets")
          .insert({
            location_id: loc.id, category_id: cat.id,
            name, asset_code: code,
            make: cat.slug === "it-udm-router" ? "Ubiquiti" : cat.slug === "it-wifi-ap" ? "Ubiquiti" : null,
            model: cat.slug === "it-udm-router" ? "UDM-Pro" : cat.slug === "it-wifi-ap" ? "U6-Pro" : null,
            status: "active",
            location_notes: cat.slug === "it-server" ? "Server rack" : null,
            created_by: actor.id,
          })
          .select("id, location_id, category_id, asset_code")
          .single();
        if (error) { console.warn(`  ! asset ${code}: ${error.message}`); continue; }
        created.push(data);
      }
    }
  }
  console.log(`  assets ready: ${created.length}`);
  return created;
}

// ── issue templates ────────────────────────────────────────────────────────
const TEMPLATES = [
  // priority, category_slug, title, description, root_cause (for resolved)
  { priority: "critical", catSlug: "it-isp", title: "Internet completely down", desc: "All members reporting no internet. Backup ISP also unreachable.", root: "isp_outage", state: "in_progress" },
  { priority: "high",     catSlug: "it-wifi-ap", title: "WiFi dropping in conference room", desc: "Members in CR-2 say WiFi reconnects every 5 min.", root: "config_issue", state: "resolved_within_sla" },
  { priority: "high",     catSlug: "it-switch", title: "Switch on Floor 2 stopped passing traffic", desc: "Half the floor offline. Power-cycle helped temporarily.", root: "hardware_failure", state: "in_progress" },
  { priority: "medium",   catSlug: "it-printer", title: "Printer paper jam, won't clear", desc: "Front desk printer keeps reporting jam after clearing.", root: "wear_and_tear", state: "resolved_within_sla" },
  { priority: "medium",   catSlug: "it-wifi-ap", title: "Slow WiFi near reception", desc: "Speed test shows 3 Mbps at reception. AP signal looks low.", root: "config_issue", state: "acknowledged" },
  { priority: "low",      catSlug: "it-printer", title: "Printer toner low warning", desc: "Toner replacement needed soon, not urgent.", root: "wear_and_tear", state: "new" },
  { priority: "high",     catSlug: "it-cctv", title: "CCTV NVR offline", desc: "NVR unreachable, recording paused.", root: "power_issue", state: "resolved_breached" },
  { priority: "critical", catSlug: "it-udm-router", title: "UDM rebooting in loop", desc: "UDM keeps rebooting every 15 minutes since this morning.", root: "hardware_failure", state: "resolved_within_sla" },
  { priority: "medium",   catSlug: "it-lan", title: "LAN socket dead at desk D-12", desc: "Member moved to ethernet, port shows no link light.", root: "hardware_failure", state: "resolved_within_sla" },
  { priority: "low",      catSlug: "it-workstation", title: "Kiosk PC frozen", desc: "Reception kiosk stuck on welcome screen.", root: "user_error", state: "closed" },
  { priority: "high",     catSlug: "it-access", title: "Door access reader not scanning", desc: "Main entrance reader not reading cards.", root: "hardware_failure", state: "in_progress" },
  { priority: "medium",   catSlug: "it-wifi-ap", title: "WiFi password rotation request", desc: "Request to rotate guest WiFi password monthly.", root: "scheduled_maintenance", state: "new" },
  { priority: "low",      catSlug: "it-other", title: "VC laptop HDMI flicker", desc: "HDMI cable seems loose, occasional black screen.", root: "wear_and_tear", state: "resolved_within_sla" },
  { priority: "high",     catSlug: "it-isp", title: "Backup ISP showing high latency", desc: "Backup link latency ~400ms, monitoring needed.", root: "isp_outage", state: "acknowledged" },
  { priority: "medium",   catSlug: "it-switch", title: "Need new VLAN for guest network", desc: "Plan: separate guest VLAN with rate limiting.", root: "scheduled_maintenance", state: "new" },
];

function pickAsset(assetIndex, locId, catId) {
  return assetIndex.get(`${locId}|${catId}`);
}

// ── compute SLA + state timing ─────────────────────────────────────────────
function slaHrsFor(cat, priority) {
  return Number({
    critical: cat.default_sla_critical_hrs,
    high: cat.default_sla_high_hrs,
    medium: cat.default_sla_medium_hrs,
    low: cat.default_sla_low_hrs,
  }[priority]);
}

async function highestSeqForYear(scopePrefix, year) {
  const yearPrefix = `${scopePrefix}-${year}-`;
  const { data } = await supa
    .from("facility_issues")
    .select("issue_number")
    .like("issue_number", `${yearPrefix}%`)
    .order("issue_number", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) return 0;
  const m = String(data[0].issue_number).match(/-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// ── seed issues ────────────────────────────────────────────────────────────
async function seedIssues(locations, categories, assets, actor) {
  const catBySlug = new Map(categories.map((c) => [c.slug, c]));
  const assetIndex = new Map();
  for (const a of assets) assetIndex.set(`${a.location_id}|${a.category_id}`, a);

  const year = new Date().getFullYear();
  let seq = await highestSeqForYear("IT", year);

  let created = 0;
  for (const loc of locations) {
    for (const tpl of TEMPLATES) {
      const cat = catBySlug.get(tpl.catSlug);
      if (!cat) continue;

      seq += 1;
      const issueNumber = `IT-${year}-${String(seq).padStart(5, "0")}`;
      const slaHrs = slaHrsFor(cat, tpl.priority);

      // Reported between 12 hours and 14 days ago
      const ageMin = Math.floor(Math.random() * (14 * 24 * 60 - 12 * 60)) + 12 * 60;
      const reportedAt = new Date(Date.now() - ageMin * 60 * 1000);
      const slaTargetAt = new Date(reportedAt.getTime() + slaHrs * 3600 * 1000);

      const row = {
        issue_number: issueNumber,
        scope: "it",
        category_id: cat.id,
        location_id: loc.id,
        asset_id: pickAsset(assetIndex, loc.id, cat.id)?.id || null,
        title: tpl.title,
        description: tpl.desc,
        priority: tpl.priority,
        status: "new",
        reported_by: actor.id,
        reported_via: ["walk_in", "phone", "whatsapp", "proactive"][Math.floor(Math.random() * 4)],
        reported_at: reportedAt.toISOString(),
        sla_target_at: slaTargetAt.toISOString(),
        parts_cost: 0,
      };

      // Apply state
      const now = new Date();
      switch (tpl.state) {
        case "new":
          break;
        case "acknowledged":
          row.status = "acknowledged";
          row.acknowledged_at = new Date(reportedAt.getTime() + 30 * 60 * 1000).toISOString();
          row.assigned_to = actor.id;
          row.assigned_at = row.acknowledged_at;
          row.assigned_by = actor.id;
          break;
        case "in_progress":
          row.status = "in_progress";
          row.acknowledged_at = new Date(reportedAt.getTime() + 30 * 60 * 1000).toISOString();
          row.started_at = new Date(reportedAt.getTime() + 60 * 60 * 1000).toISOString();
          row.assigned_to = actor.id;
          row.assigned_at = row.acknowledged_at;
          row.assigned_by = actor.id;
          // Mark breached if past SLA
          if (now > slaTargetAt) row.sla_breached = true;
          break;
        case "resolved_within_sla": {
          const ackAt = new Date(reportedAt.getTime() + 20 * 60 * 1000);
          const resAt = new Date(reportedAt.getTime() + slaHrs * 0.5 * 3600 * 1000);
          row.status = "resolved";
          row.acknowledged_at = ackAt.toISOString();
          row.started_at = ackAt.toISOString();
          row.resolved_at = resAt.toISOString();
          row.assigned_to = actor.id;
          row.assigned_at = ackAt.toISOString();
          row.assigned_by = actor.id;
          row.resolution_root_cause = tpl.root;
          row.resolution_notes = "Identified root cause, applied fix, verified with end-user.";
          row.resolution_time_minutes = Math.round((resAt - ackAt) / 60000);
          row.sla_breached = false;
          row.satisfaction_requested_at = resAt.toISOString();
          // 60% chance of satisfaction reply
          if (Math.random() < 0.6) {
            row.satisfaction_rating = 4 + (Math.random() < 0.5 ? 1 : 0);
            row.satisfaction_comment = row.satisfaction_rating === 5 ? "Quick fix, thanks!" : "Fixed promptly.";
            row.satisfaction_received_at = new Date(resAt.getTime() + 3 * 3600 * 1000).toISOString();
          }
          break;
        }
        case "resolved_breached": {
          const ackAt = new Date(reportedAt.getTime() + 60 * 60 * 1000);
          const resAt = new Date(slaTargetAt.getTime() + slaHrs * 0.4 * 3600 * 1000);
          row.status = "resolved";
          row.acknowledged_at = ackAt.toISOString();
          row.started_at = ackAt.toISOString();
          row.resolved_at = resAt.toISOString();
          row.assigned_to = actor.id;
          row.assigned_at = ackAt.toISOString();
          row.assigned_by = actor.id;
          row.resolution_root_cause = tpl.root;
          row.resolution_notes = "Took longer than expected — vendor response was slow.";
          row.resolution_time_minutes = Math.round((resAt - ackAt) / 60000);
          row.sla_breached = true;
          row.satisfaction_requested_at = resAt.toISOString();
          break;
        }
        case "closed": {
          const ackAt = new Date(reportedAt.getTime() + 15 * 60 * 1000);
          const resAt = new Date(reportedAt.getTime() + 60 * 60 * 1000);
          row.status = "closed";
          row.acknowledged_at = ackAt.toISOString();
          row.started_at = ackAt.toISOString();
          row.resolved_at = resAt.toISOString();
          row.closed_at = new Date(resAt.getTime() + 24 * 3600 * 1000).toISOString();
          row.assigned_to = actor.id;
          row.assigned_at = ackAt.toISOString();
          row.assigned_by = actor.id;
          row.resolution_root_cause = tpl.root;
          row.resolution_notes = "Resolved on the spot.";
          row.resolution_time_minutes = Math.round((resAt - ackAt) / 60000);
          row.sla_breached = false;
          break;
        }
      }

      const { data: issue, error } = await supa
        .from("facility_issues")
        .insert(row)
        .select("id, issue_number, status")
        .single();
      if (error) {
        console.warn(`  ! ${issueNumber}: ${error.message}`);
        continue;
      }
      created += 1;

      // Add a "created" event so the timeline isn't empty
      await supa.from("facility_issue_events").insert({
        issue_id: issue.id,
        event_type: "created",
        actor_id: actor.id,
        actor_label: actor.full_name,
        message: `Reported via ${row.reported_via}`,
        payload: { priority: tpl.priority, scope: "it" },
      });

      // For resolved/closed, add a status_changed event too
      if (["resolved", "closed"].includes(issue.status)) {
        await supa.from("facility_issue_events").insert({
          issue_id: issue.id,
          event_type: "resolved",
          actor_id: actor.id,
          actor_label: actor.full_name,
          message: "Marked resolved",
          payload: { root_cause: tpl.root },
        });
      }
    }
  }
  console.log(`  issues created: ${created}`);
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("→ Seeding facility demo data");
  const actor = await pickActorId();
  console.log(`  actor: ${actor.full_name} (${actor.role})`);

  const locations = await listLocations();
  console.log(`  locations: ${locations.map((l) => l.name).join(", ")}`);

  const categories = await listCategories();
  console.log(`  categories: ${categories.length}`);

  const assets = await seedAssets(locations, categories, actor);
  await seedIssues(locations, categories, assets, actor);

  console.log("✔ Done");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
