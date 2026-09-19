/**
 * Rendering for the daily query digest email. Pure — no mailer, no env — so
 * the escaping and subject line can be unit-tested. Sending lives in notify.ts.
 */

import type { DigestBadge, DigestBadgeKind } from "./digest";

/** Minimal escaping — reply bodies are user-typed and land inside HTML. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BADGE_STYLE: Record<DigestBadgeKind, { bg: string; fg: string }> = {
  escalated: { bg: "#fee2e2", fg: "#b91c1c" },
  overdue: { bg: "#fee2e2", fg: "#b91c1c" },
  new: { bg: "#ccfbf1", fg: "#015E65" },
  replied: { bg: "#dbeafe", fg: "#1d4ed8" },
  resolved: { bg: "#dcfce7", fg: "#15803d" },
  payment_verified: { bg: "#dcfce7", fg: "#15803d" },
  payment_rejected: { bg: "#fee2e2", fg: "#b91c1c" },
  reopened: { bg: "#fef3c7", fg: "#b45309" },
  rerouted: { bg: "#fef3c7", fg: "#b45309" },
};

export interface QueryDigestEmailItem {
  /** Deep link to the thread. */
  url: string;
  /** "Bluescale Analytics · TWV-C-0112 · STM-0042". */
  entityLabel: string;
  kindLabel: string;
  badges: DigestBadge[];
  awaitingYou: boolean;
  latestReply: string | null;
  neededBy: string | null;
}

function pill(text: string, bg: string, fg: string): string {
  return `<span style="display:inline-block;padding:2px 8px;margin:0 4px 4px 0;border-radius:10px;font-size:12px;font-weight:600;background:${bg};color:${fg}">${esc(text)}</span>`;
}

function itemHtml(item: QueryDigestEmailItem): string {
  const yourTurn = item.awaitingYou ? pill("Your turn", "#1a1a1a", "#ffffff") : "";
  const badges = item.badges.map((b) => pill(b.label, BADGE_STYLE[b.kind].bg, BADGE_STYLE[b.kind].fg)).join("");
  const reply = item.latestReply
    ? `<p style="margin:6px 0 0;color:#555;font-size:13px;border-left:3px solid #e5e5e5;padding-left:8px">${esc(item.latestReply)}</p>`
    : "";
  const due = item.neededBy ? ` · needed by ${esc(item.neededBy)}` : "";
  return `
  <div style="padding:12px 0;border-top:1px solid #e5e5e5">
    <div>${yourTurn}${badges}</div>
    <p style="margin:2px 0 0;color:#1a1a1a"><strong>${esc(item.entityLabel)}</strong></p>
    <p style="margin:2px 0 0;color:#777;font-size:12px">${esc(item.kindLabel)}${due}</p>
    ${reply}
    <a href="${esc(item.url)}" style="display:inline-block;margin-top:6px;color:#015E65;font-size:13px">Open query</a>
  </div>`;
}

export function digestSubject(items: QueryDigestEmailItem[]): string {
  const overdue = items.filter((i) => i.badges.some((b) => b.kind === "overdue" || b.kind === "escalated")).length;
  const head = `Query digest · ${items.length} ${items.length === 1 ? "thread" : "threads"}`;
  return overdue > 0 ? `${head} · ${overdue} overdue` : head;
}

export function renderQueryDigest(items: QueryDigestEmailItem[]): { subject: string; html: string } {
  return {
    subject: digestSubject(items),
    html: `
<div style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:24px">
  <h2 style="color:#1a1a1a;margin:0 0 4px">Your queries</h2>
  <p style="margin:0 0 12px;color:#777;font-size:13px">One summary a day, instead of an email per reply.</p>
  ${items.map(itemHtml).join("")}
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0" />
  <p style="font-size:12px;color:#999">The WorkVilla — Queries</p>
</div>`,
  };
}
