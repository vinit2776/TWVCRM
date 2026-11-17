// The alert email. Pure (no sending) so the wording can be unit-tested and previewed.

import type { AlertEffect, AlertKind } from "./engine";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function istTime(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(0)}%`;
const kw = (n: number) => `${n.toFixed(1)} kW`;

export interface AlertEmailInput {
  kind: AlertKind;
  effect: AlertEffect;
  locationName: string;
  ruleName: string;
  tolerancePct: number;
  minKw: number;
  persistSlots: number;
  openedMs: number; // slot at which the episode opened
  startedMs: number; // first slot of the deviation
  appUrl: string;
  testMode: boolean;
}

export function buildAlertEmail(i: AlertEmailInput): { subject: string; html: string } {
  const e = i.effect;
  const hoursOpen = Math.max(0, Math.round((e.tsMs - i.openedMs) / 3_600_000));
  const dir = e.devPct >= 0 ? "above" : "below";
  const prefix = i.testMode ? "[TEST] " : "";
  const since = istTime(i.startedMs);

  let subject: string;
  let lead: string;
  switch (i.kind) {
    case "opened":
      subject = `⚡ ${i.locationName} usage ${pct(e.devPct)} vs usual, since ${since}`;
      lead = `<b>${esc(i.locationName)}</b> has run ${dir} its usual pattern for ${i.persistSlots * 15} minutes or more.`;
      break;
    case "worse":
      subject = `⚠ ${i.locationName} deviation worsened to ${pct(e.devPct)}`;
      lead = `The deviation at <b>${esc(i.locationName)}</b> that began at ${since} has got worse.`;
      break;
    case "reminder":
      subject = `⏰ Still open: ${i.locationName} ${pct(e.devPct)}, ${hoursOpen}h so far`;
      lead = `The deviation at <b>${esc(i.locationName)}</b> that began at ${since} has not cleared.`;
      break;
    default:
      subject = `✓ ${i.locationName} back to normal`;
      lead = `<b>${esc(i.locationName)}</b> is back within its usual range after the deviation that began at ${since}.`;
  }

  const detail = i.kind === "resolved" ? "" :
    `<table style="border-collapse:collapse;margin:12px 0;width:100%;background:#f5f5f5;border-radius:6px;">
      <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Slot ${istTime(e.tsMs)} IST</td><td style="padding:8px 16px;font-weight:bold;border-bottom:1px solid #e5e7eb;">${kw(e.actualKw)} (${pct(e.devPct)})</td></tr>
      <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Usual for this slot</td><td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;">${kw(e.typicalKw)}</td></tr>
      <tr><td style="padding:8px 16px;color:#666;">Extra energy in this episode</td><td style="padding:8px 16px;">${e.extraKwh.toFixed(1)} kWh</td></tr>
    </table>`;

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      ${i.testMode ? '<p style="background:#fef3c7;color:#92400e;padding:8px 12px;border-radius:6px;font-size:12px;">TEST — this is what the alert would send. Nothing else was sent.</p>' : ""}
      <p style="color:#333;font-size:14px;">${lead}</p>
      ${detail}
      <p style="color:#666;font-size:12px;">Usual = median of this slot over the last 30 days of the same kind of day. Rule “${esc(i.ruleName)}”: tolerance ±${i.tolerancePct}% and at least ${i.minKw} kW, for ${i.persistSlots * 15} minutes.</p>
      <p style="margin:16px 0 0;"><a href="${esc(i.appUrl)}/admin/energy-alerts" style="background:#015E65;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:14px;">Open energy alerts</a>
      <span style="color:#666;font-size:12px;"> &nbsp;Acknowledge or mute it there.</span></p>
    </div>`;

  return { subject: prefix + subject, html };
}
