// Server side of energy slot alerts: reads the local energy ledger, runs each enabled
// rule through the pure engine, and records / sends what it decides. It never calls
// OneGrid (the hourly ledger capture does that) and never emails a customer — only the
// staff addresses saved on a rule.
//
// Nothing can email unless BOTH the rule is Live AND app_settings.energy_alerts_cron_mode
// is 'live'. Otherwise the decision is recorded as 'test' and nobody is contacted.

import type { SupabaseClient } from "@supabase/supabase-js";
import { EMAIL_FROM, EMAIL_REPLY_TO, resend } from "@/lib/mailer";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { addDays, istDateOf, istToday, type HolidayEntry, type LedgerBucket } from "@/lib/energy-baseline";
import { ALERT_BASELINE_DAYS, MIN_PEER_DAYS, makeBaselineCtx, typicalFor, type TypicalCurve } from "./baseline";
import { dateStartMs, BACKTEST_DAYS } from "./backtest";
import { buildAlertEmail } from "./email";
import { SLOT_MS, stepSlot, type AlertEffect, type AlertKind, type EngineState, type OpenEpisode, type RuleParams } from "./engine";
import { BASELINE_EXCLUDING_REASONS } from "./schema";

export type EnergyAlertsMode = "off" | "dry_run" | "live";
export const ENERGY_ALERTS_MODE_SETTING = "energy_alerts_cron_mode";

// A slot older than this when we get to it is recorded as seen but cannot open or worsen
// an episode: after an outage the ledger catches up with hours of old slots at once, and
// replaying them would send a burst of alerts about the past.
export const STALE_SLOTS = 12;

/** Anything missing or unrecognised is a dry run, never live. */
export function parseMode(value: string | null | undefined): EnergyAlertsMode {
  return value === "off" || value === "live" ? value : "dry_run";
}

export async function loadMode(admin: SupabaseClient): Promise<EnergyAlertsMode> {
  const { data } = await admin.from("app_settings").select("value").eq("key", ENERGY_ALERTS_MODE_SETTING).maybeSingle();
  return parseMode(data?.value as string | undefined);
}

export interface RuleRow {
  id: string;
  name: string;
  location_id: string;
  tolerance_pct: number;
  min_kw: number;
  direction: "both" | "high" | "low";
  persist_slots: number;
  recover_slots: number;
  reminder_schedule: "std" | "4h" | "none";
  daily_cap: number;
  recipients: string[];
  send_resolved: boolean;
  mode: "test" | "live";
  enabled: boolean;
  muted_until: string | null;
  last_slot_ts: string | null;
  streak_slots: number;
  streak_dir: number;
  streak_kwh: number;
}

export const ruleParams = (r: Pick<RuleRow, "tolerance_pct" | "min_kw" | "direction" | "persist_slots" | "recover_slots" | "reminder_schedule">): RuleParams => ({
  tolerancePct: Number(r.tolerance_pct),
  minKw: Number(r.min_kw),
  direction: r.direction,
  persistSlots: r.persist_slots,
  recoverSlots: r.recover_slots,
  reminder: r.reminder_schedule,
});

const PAGE = 1000;
const MAX_PAGES = 12;

export async function loadLedger(admin: SupabaseClient, locationId: string, deviceId: string, fromDate: string): Promise<LedgerBucket[]> {
  const rows: LedgerBucket[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await admin
      .from("location_energy_readings")
      .select("ts, energy_delta_wh, cumulative_wh")
      .eq("location_id", locationId)
      .eq("device_id", deviceId)
      .gte("ts", `${fromDate}T00:00:00+05:30`)
      .order("ts", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data as LedgerBucket[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

export async function loadHolidays(admin: SupabaseClient, locationId: string, fromDate: string): Promise<HolidayEntry[]> {
  const { data, error } = await admin
    .from("public_holidays")
    .select("holiday_date, name")
    .or(`location_id.is.null,location_id.eq.${locationId}`)
    .gte("holiday_date", fromDate);
  if (error) throw new Error(error.message);
  return (data ?? []).map((h) => ({ date: h.holiday_date as string, name: h.name as string }));
}

/** Lookback needed to cover the baseline window plus the backtest days. */
export const LEDGER_LOOKBACK_DAYS = ALERT_BASELINE_DAYS + BACKTEST_DAYS + 5;

export interface LocationMeter { id: string; name: string; deviceId: string }

export async function loadMeter(admin: SupabaseClient, locationId: string): Promise<LocationMeter | { error: string }> {
  // OneGrid settings live on location_electricity_config, not on locations.
  const { data } = await admin
    .from("location_electricity_config")
    .select("location_id, onegrid_enabled, onegrid_default_device_id, location:locations(name)")
    .eq("location_id", locationId)
    .maybeSingle();
  const loc = data?.location as { name: string } | { name: string }[] | null | undefined;
  const name = (Array.isArray(loc) ? loc[0]?.name : loc?.name) ?? "This location";
  if (!data || !data.onegrid_enabled) return { error: `${name} does not have OneGrid enabled` };
  if (!data.onegrid_default_device_id) return { error: `${name} has no default OneGrid meter chosen` };
  return { id: locationId, name, deviceId: data.onegrid_default_device_id as string };
}

export interface EffectOutcome {
  kind: AlertKind;
  status: "sent" | "test" | "held" | "muted" | "failed" | "skipped";
  tsMs: number;
  devPct: number;
  subject?: string;
  error?: string;
}

export interface RuleRunSummary {
  ruleId: string;
  ruleName: string;
  location?: string;
  slotsProcessed: number;
  peers?: number;
  outcomes: EffectOutcome[];
  openEpisode: boolean;
  note?: string;
  error?: string;
}

interface RunOpts {
  now: Date;
  mode: EnergyAlertsMode;
  dry: boolean;
  appUrl: string;
}

const istDay = (ms: number) => istDateOf(new Date(ms).toISOString());

/** IST dates (YYYY-MM-DD) from `fromMs` to `toMs`, inclusive. */
function datesBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  let d = istDay(fromMs);
  const end = istDay(toMs);
  for (let guard = 0; d <= end && guard < 60; guard++) { out.push(d); d = addDays(d, 1); }
  return out;
}

async function loadExcludedDates(admin: SupabaseClient, ruleLocationId: string, sinceDate: string, now: Date): Promise<Set<string>> {
  const { data } = await admin
    .from("energy_alert_episodes")
    .select("started_at, closed_at, status, ack_reason")
    .eq("location_id", ruleLocationId)
    .gte("started_at", `${addDays(sinceDate, -1)}T00:00:00+05:30`);
  const out = new Set<string>();
  for (const e of data ?? []) {
    const reason = e.ack_reason as string | null;
    // A fault still open, or one acknowledged as a known/abnormal day, is not "usual".
    if (e.status !== "open" && !(reason && BASELINE_EXCLUDING_REASONS.includes(reason))) continue;
    const end = e.closed_at ? new Date(e.closed_at as string).getTime() : now.getTime();
    for (const d of datesBetween(new Date(e.started_at as string).getTime(), end)) out.add(d);
  }
  return out;
}

export async function evaluateRule(admin: SupabaseClient, rule: RuleRow, opts: RunOpts): Promise<RuleRunSummary> {
  const summary: RuleRunSummary = { ruleId: rule.id, ruleName: rule.name, slotsProcessed: 0, outcomes: [], openEpisode: false };
  const meter = await loadMeter(admin, rule.location_id);
  if ("error" in meter) return { ...summary, note: meter.error };
  summary.location = meter.name;

  const { now } = opts;
  const today = istToday(now);
  const fromDate = addDays(today, -(ALERT_BASELINE_DAYS + 5));
  const [rows, holidays, excluded] = await Promise.all([
    loadLedger(admin, meter.id, meter.deviceId, fromDate),
    loadHolidays(admin, meter.id, fromDate),
    loadExcludedDates(admin, meter.id, fromDate, now),
  ]);
  const ctx = makeBaselineCtx(rows, holidays, today, excluded);
  const typicalCache = new Map<string, TypicalCurve>();
  const typicalOf = (date: string) => {
    let t = typicalCache.get(date);
    if (!t) { t = typicalFor(ctx, date); typicalCache.set(date, t); }
    return t;
  };

  // Slots to judge: completed slots of yesterday and today we have not judged before.
  const cursorMs = rule.last_slot_ts ? new Date(rule.last_slot_ts).getTime() : -Infinity;
  const staleBeforeMs = now.getTime() - STALE_SLOTS * SLOT_MS;
  const slots: { tsMs: number; actual: number | null; typical: number | null; stale: boolean }[] = [];
  for (const date of [addDays(today, -1), today]) {
    const curve = ctx.curves.get(date);
    if (!curve) continue;
    let last = -1;
    curve.forEach((v, k) => { if (v != null) last = k; });
    const typ = typicalOf(date);
    const start = dateStartMs(date);
    for (let k = 0; k <= last; k++) {
      const tsMs = start + k * SLOT_MS;
      if (tsMs <= cursorMs) continue;
      slots.push({ tsMs, actual: curve[k], typical: typ.typical[k], stale: tsMs < staleBeforeMs });
    }
  }
  summary.peers = typicalOf(today).peers;
  if (slots.length === 0) return { ...summary, note: typicalOf(today).peers < MIN_PEER_DAYS ? "Not enough comparable days yet" : "No new slots" };

  // Existing open episode and carried streak.
  const { data: epRow } = await admin.from("energy_alert_episodes").select("*").eq("rule_id", rule.id).eq("status", "open").maybeSingle();
  let epId: string | null = (epRow?.id as string) ?? null;
  let state: EngineState = {
    streakSlots: rule.streak_slots,
    streakDir: rule.streak_dir as 0 | 1 | -1,
    streakKwh: Number(rule.streak_kwh),
    episode: epRow ? {
      dir: epRow.direction as 1 | -1,
      startedMs: new Date(epRow.started_at as string).getTime(),
      openedMs: new Date(epRow.opened_at as string).getTime(),
      peakDevPct: Number(epRow.peak_dev_pct),
      step: epRow.step as number,
      remindersSent: epRow.reminders_sent as number,
      calmSlots: epRow.calm_slots as number,
      extraKwh: Number(epRow.extra_kwh),
      acked: epRow.acked_at != null,
    } : null,
  };
  // A hole between the last judged slot and the first new one breaks a building streak.
  if (!state.episode && rule.last_slot_ts && slots[0].tsMs - cursorMs > SLOT_MS) {
    state = { ...state, streakSlots: 0, streakDir: 0, streakKwh: 0 };
  }

  const params = ruleParams(rule);
  const globalLive = opts.mode === "live";
  const muted = rule.muted_until != null && new Date(rule.muted_until).getTime() > now.getTime();

  // Emails already decided today, per IST date, for the daily cap.
  const used = new Map<string, number>();
  {
    const { data: ev } = await admin
      .from("energy_alert_events").select("slot_ts, status").eq("rule_id", rule.id)
      .in("status", ["claimed", "sent", "test"]).gte("slot_ts", `${addDays(today, -1)}T00:00:00+05:30`);
    for (const e of ev ?? []) { const d = istDay(new Date(e.slot_ts as string).getTime()); used.set(d, (used.get(d) ?? 0) + 1); }
  }

  let lastEpisodeInfo: OpenEpisode | null = state.episode;
  for (const slot of slots) {
    const res = stepSlot(state, { tsMs: slot.tsMs, actualKw: slot.actual, typicalKw: slot.typical }, params);
    state = res.state;
    summary.slotsProcessed++;
    lastEpisodeInfo = res.state.episode ?? res.closed ?? lastEpisodeInfo;

    // An old slot may move state but never contacts anyone.
    if (res.opened && !opts.dry) {
      const ep = state.episode!;
      const { data: ins, error } = await admin.from("energy_alert_episodes").insert({
        rule_id: rule.id, location_id: rule.location_id, direction: ep.dir,
        started_at: new Date(ep.startedMs).toISOString(), opened_at: new Date(ep.openedMs).toISOString(),
        last_slot_ts: new Date(slot.tsMs).toISOString(), peak_dev_pct: ep.peakDevPct, step: ep.step, extra_kwh: ep.extraKwh,
      }).select("id").single();
      if (error) { summary.error = `Could not open episode: ${error.message}`; break; }
      epId = ins.id as string;
    }

    for (const eff of res.effects) {
      if (eff.kind === "resolved" && !rule.send_resolved) { summary.outcomes.push({ kind: eff.kind, status: "skipped", tsMs: eff.tsMs, devPct: eff.devPct }); continue; }
      if (slot.stale) { summary.outcomes.push({ kind: eff.kind, status: "skipped", tsMs: eff.tsMs, devPct: eff.devPct, error: "Older than 3 hours when processed" }); continue; }
      const outcome = await decideAndSend({ admin, rule, meter, eff, info: lastEpisodeInfo, epId, muted, globalLive, used, opts });
      summary.outcomes.push(outcome);
    }

    if (res.closed && !opts.dry && epId) {
      await admin.from("energy_alert_episodes").update({
        status: "closed", closed_at: new Date(slot.tsMs).toISOString(), last_slot_ts: new Date(slot.tsMs).toISOString(),
        peak_dev_pct: res.closed.peakDevPct, step: res.closed.step, reminders_sent: res.closed.remindersSent,
        calm_slots: res.closed.calmSlots, extra_kwh: res.closed.extraKwh, updated_at: new Date().toISOString(),
      }).eq("id", epId);
      epId = null;
    }
  }

  summary.openEpisode = state.episode != null;
  if (!opts.dry && !summary.error) {
    const lastTs = slots[slots.length - 1].tsMs;
    if (state.episode && epId) {
      await admin.from("energy_alert_episodes").update({
        last_slot_ts: new Date(lastTs).toISOString(), peak_dev_pct: state.episode.peakDevPct, step: state.episode.step,
        reminders_sent: state.episode.remindersSent, calm_slots: state.episode.calmSlots, extra_kwh: state.episode.extraKwh,
        updated_at: new Date().toISOString(),
      }).eq("id", epId);
    }
    await admin.from("energy_alert_rules").update({
      last_slot_ts: new Date(lastTs).toISOString(), streak_slots: state.streakSlots, streak_dir: state.streakDir,
      streak_kwh: state.streakKwh, updated_at: new Date().toISOString(),
    }).eq("id", rule.id);
  }
  return summary;
}

async function decideAndSend(a: {
  admin: SupabaseClient; rule: RuleRow; meter: LocationMeter; eff: AlertEffect; info: OpenEpisode | null; epId: string | null;
  muted: boolean; globalLive: boolean; used: Map<string, number>; opts: RunOpts;
}): Promise<EffectOutcome> {
  const { admin, rule, meter, eff, info, epId, muted, globalLive, used, opts } = a;
  const base = { kind: eff.kind, tsMs: eff.tsMs, devPct: eff.devPct };
  const wantLive = rule.mode === "live" && globalLive;
  const day = istDay(eff.tsMs);

  let status: "claimed" | "test" | "held" | "muted";
  if (muted) status = "muted";
  else if ((used.get(day) ?? 0) >= rule.daily_cap) status = "held";
  else { used.set(day, (used.get(day) ?? 0) + 1); status = wantLive ? "claimed" : "test"; }

  const email = buildAlertEmail({
    kind: eff.kind, effect: eff, locationName: meter.name, ruleName: rule.name, tolerancePct: Number(rule.tolerance_pct),
    minKw: Number(rule.min_kw), persistSlots: rule.persist_slots, openedMs: info?.openedMs ?? eff.tsMs,
    startedMs: info?.startedMs ?? eff.tsMs, appUrl: opts.appUrl, testMode: status === "test",
  });
  const shown = status === "claimed" ? "sent" : status;
  if (opts.dry) return { ...base, status: shown, subject: email.subject };

  // Claim first: the unique (rule, slot, kind) key means a retried or overlapping run cannot decide twice.
  const { data: ev, error } = await admin.from("energy_alert_events").insert({
    rule_id: rule.id, episode_id: epId, kind: eff.kind, status, slot_ts: new Date(eff.tsMs).toISOString(),
    actual_kw: eff.actualKw, typical_kw: eff.typicalKw, dev_pct: eff.devPct, extra_kwh: eff.extraKwh,
    subject: email.subject, recipients: rule.recipients,
  }).select("id").single();
  if (error) {
    if (error.code === "23505") return { ...base, status: "skipped", error: "Already decided for this slot" };
    return { ...base, status: "failed", error: error.message };
  }
  if (status !== "claimed") return { ...base, status: shown, subject: email.subject };

  if (rule.recipients.length === 0) {
    await admin.from("energy_alert_events").update({ status: "failed", error: "No recipients on the rule" }).eq("id", ev.id);
    return { ...base, status: "failed", subject: email.subject, error: "No recipients on the rule" };
  }
  try {
    await resend.emails.send({ from: EMAIL_FROM, to: rule.recipients, replyTo: EMAIL_REPLY_TO, subject: email.subject, html: email.html });
    await admin.from("energy_alert_events").update({ status: "sent" }).eq("id", ev.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Email send failed";
    console.error("[energy-alerts] email failed:", message);
    await admin.from("energy_alert_events").update({ status: "failed", error: message }).eq("id", ev.id);
    return { ...base, status: "failed", subject: email.subject, error: message };
  }

  // In-app notice for recipients who are CRM users. Best effort; the email already went.
  try {
    const { data: users } = await admin.from("users").select("id").in("email", rule.recipients).eq("is_active", true);
    await createNotificationsForUsers((users ?? []).map((u) => u.id as string), {
      type: "energy_alert", title: email.subject, body: `${meter.name}: ${eff.actualKw.toFixed(1)} kW vs usual ${eff.typicalKw.toFixed(1)} kW`,
      url: "/admin/energy-alerts", entityType: "energy_alert_rule", entityId: rule.id,
    });
  } catch (err) {
    console.error("[energy-alerts] in-app notice failed:", err instanceof Error ? err.message : err);
  }
  return { ...base, status: "sent", subject: email.subject };
}

export async function evaluateAllRules(
  admin: SupabaseClient,
  opts: { now?: Date; dry?: boolean; ruleId?: string; appUrl: string; modeOverride?: EnergyAlertsMode }
): Promise<{ mode: EnergyAlertsMode; rules: RuleRunSummary[] }> {
  const mode = opts.modeOverride ?? (await loadMode(admin));
  if (mode === "off") return { mode, rules: [] };
  let q = admin.from("energy_alert_rules").select("*").eq("enabled", true);
  if (opts.ruleId) q = q.eq("id", opts.ruleId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rules: RuleRunSummary[] = [];
  for (const rule of (data ?? []) as RuleRow[]) {
    try {
      rules.push(await evaluateRule(admin, rule, { now: opts.now ?? new Date(), mode, dry: opts.dry ?? false, appUrl: opts.appUrl }));
    } catch (err) {
      console.error(`[energy-alerts] rule ${rule.id} failed:`, err instanceof Error ? err.message : err);
      rules.push({ ruleId: rule.id, ruleName: rule.name, slotsProcessed: 0, outcomes: [], openEpisode: false, error: err instanceof Error ? err.message : "Rule failed" });
    }
  }
  return { mode, rules };
}
