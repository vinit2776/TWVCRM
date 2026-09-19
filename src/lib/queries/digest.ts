/**
 * Who hears what in the daily query digest.
 *
 * Replaces two email streams that each sent one message per event: a real-time
 * email on every reply, and a per-thread chase email every six hours. Both
 * routed to the same people, so a busy day stacked into a pile. This module
 * folds them into one list per person; the cron sends one email from it.
 *
 * Pure — no Supabase, no mailer — so the routing is unit-testable
 * (src/lib/__tests__/queries-digest.test.ts). Recipient rules come from
 * resolveRecipients() and timing rules from decideChase(), unchanged: this
 * only changes how many emails the same decisions turn into.
 */

import { queryEntityDef } from "./registry";
import { isAwaitingUser, resolveRecipients, type CandidateUser } from "./audience";
import { decideChase, type ChaseKind } from "./chase";
import type { QueryKind, QueryTargeting } from "./types";

/**
 * A little over 24h so a cron that starts a few seconds late can't leave a gap
 * between two runs. The cost is that an event in the overlap can appear twice,
 * which is far better than one never appearing.
 */
export const DIGEST_LOOKBACK_HOURS = 24.25;

/** Preview length for the latest reply shown under a thread. */
const PREVIEW_LIMIT = 140;

export type DigestBadgeKind =
  | "escalated"
  | "overdue"
  | "new"
  | "replied"
  | "resolved"
  | "reopened"
  | "rerouted"
  | "payment_verified"
  | "payment_rejected";

export interface DigestBadge {
  kind: DigestBadgeKind;
  label: string;
}

export interface DigestMessage {
  id: string;
  created_by: string;
  created_at: string;
  event_type: string;
  body: string | null;
}

export interface DigestThread {
  id: string;
  entity_type: string;
  entity_id: string;
  created_by: string;
  created_at: string;
  status: "open" | "resolved";
  kind: QueryKind;
  needed_by: string | null;
  escalated_at: string | null;
  last_nudged_at: string | null;
  targeting: QueryTargeting;
  messages: DigestMessage[];
}

export interface DigestCandidate extends CandidateUser {
  email: string | null;
}

export interface DigestItem {
  queryId: string;
  entityType: string;
  entityId: string;
  kind: QueryKind;
  /** Most urgent first. Never empty. */
  badges: DigestBadge[];
  /** The ball is in this person's court right now. */
  awaitingYou: boolean;
  /** Most recent reply by someone else inside the window, if any. */
  latestReply: string | null;
  neededBy: string | null;
  /** Used only to order the list. */
  urgency: number;
  createdAt: string;
}

export interface ChasedThread {
  thread: DigestThread;
  kind: Exclude<ChaseKind, "none">;
  overdueDays: number;
  /** Everyone the chase reached, including management once well overdue. */
  recipientIds: string[];
}

export interface QueryDigest {
  byRecipient: Map<string, DigestItem[]>;
  chased: ChasedThread[];
}

const MANAGEMENT_ROLES: readonly string[] = ["admin", "manager"];

/** Events a person can read as "something happened", besides a plain reply. */
const STATE_EVENTS: Record<string, { kind: DigestBadgeKind; label: string }> = {
  resolved: { kind: "resolved", label: "Resolved" },
  reopened: { kind: "reopened", label: "Reopened" },
  retargeted: { kind: "rerouted", label: "Re-routed" },
  payment_verified: { kind: "payment_verified", label: "Payment verified" },
  payment_rejected: { kind: "payment_rejected", label: "Payment rejected" },
};

/** Lower sorts first. */
const BADGE_URGENCY: Record<DigestBadgeKind, number> = {
  escalated: 0,
  overdue: 1,
  new: 2,
  replied: 3,
  reopened: 4,
  rerouted: 5,
  payment_rejected: 6,
  payment_verified: 7,
  resolved: 8,
};

function hoursBetween(from: string, to: Date): number {
  return (to.getTime() - new Date(from).getTime()) / 3_600_000;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function preview(body: string | null): string | null {
  if (!body) return null;
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT - 1)}…` : flat;
}

function sortedByTime<T extends { created_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function buildQueryDigest(params: {
  threads: DigestThread[];
  candidates: DigestCandidate[];
  now: Date;
}): QueryDigest {
  const { threads, candidates, now } = params;
  const windowStart = new Date(now.getTime() - DIGEST_LOOKBACK_HOURS * 3_600_000).toISOString();

  const byRecipient = new Map<string, DigestItem[]>();
  const chased: ChasedThread[] = [];
  const active = candidates.filter((c) => c.is_active !== false);

  const addItem = (recipientId: string, item: DigestItem) => {
    const list = byRecipient.get(recipientId) ?? [];
    list.push(item);
    byRecipient.set(recipientId, list);
  };

  for (const thread of threads) {
    const def = queryEntityDef(thread.entity_type);
    if (!def) continue;

    const ordered = sortedByTime(thread.messages);
    // Auto-nudges are stamped with the asker as author, so they must not be
    // mistaken for the asker speaking — either as a participant or as activity.
    const human = ordered.filter((m) => m.event_type !== "nudged");
    const openingMessageId = human.find((m) => m.event_type === "message")?.id ?? null;
    const lastSpeaker = [...human].reverse().find((m) => m.event_type === "message") ?? null;

    const participantIds = [...new Set([thread.created_by, ...human.map((m) => m.created_by)])];

    // Same audience and alert narrowing the old per-event email used. No author
    // is excluded here: "not about your own action" is applied per person below.
    const { alert } = resolveRecipients({
      query: thread.targeting,
      def,
      candidates: active,
      participantIds,
      authorId: "",
    });
    const alertIds = new Set(alert);

    // ── Chase: overdue / silent, open threads only ────────────────────────
    const decision = decideChase({
      status: thread.status,
      needed_by: thread.needed_by,
      escalated_at: thread.escalated_at,
      last_nudged_at: thread.last_nudged_at,
      // Includes the nudge markers on purpose — this is what the chase loop has
      // always measured, and changing it would change who gets escalated.
      last_message_at: ordered.length ? ordered[ordered.length - 1].created_at : null,
      now,
    });

    const chaseIds = new Set<string>();
    if (decision.kind !== "none") {
      // Never chase the asker about their own unanswered question.
      for (const id of alertIds) if (id !== thread.created_by) chaseIds.add(id);
      if (decision.involveManagement) {
        for (const c of active) {
          if (c.id !== thread.created_by && MANAGEMENT_ROLES.includes(c.role)) chaseIds.add(c.id);
        }
      }
      chased.push({
        thread,
        kind: decision.kind,
        overdueDays: decision.overdueDays,
        recipientIds: [...chaseIds],
      });
    }

    const silentHours = ordered.length ? hoursBetween(ordered[ordered.length - 1].created_at, now) : 0;

    // ── Per person ────────────────────────────────────────────────────────
    const everyone = new Set<string>([...alertIds, ...chaseIds]);
    for (const personId of everyone) {
      const person = active.find((c) => c.id === personId);
      if (!person) continue;

      const badges: DigestBadge[] = [];
      const inAlerts = alertIds.has(personId);

      if (chaseIds.has(personId)) {
        if (decision.kind === "escalate") {
          const days = Math.max(1, Math.floor(silentHours / 24));
          badges.push({ kind: "escalated", label: `No reply for ${plural(days, "day")}` });
        }
        if (decision.overdueDays > 0) {
          badges.push({ kind: "overdue", label: `Overdue ${plural(decision.overdueDays, "day")}` });
        }
      }

      if (inAlerts) {
        const inWindow = human.filter((m) => m.created_at >= windowStart && m.created_by !== personId);

        if (thread.created_at >= windowStart && thread.created_by !== personId) {
          badges.push({ kind: "new", label: "New" });
        }

        const replies = inWindow.filter((m) => m.event_type === "message" && m.id !== openingMessageId);
        if (replies.length > 0) {
          badges.push({
            kind: "replied",
            label: replies.length === 1 ? "1 new reply" : `${replies.length} new replies`,
          });
        }

        const seen = new Set<DigestBadgeKind>();
        for (const m of inWindow) {
          const state = STATE_EVENTS[m.event_type];
          if (state && !seen.has(state.kind)) {
            seen.add(state.kind);
            badges.push({ kind: state.kind, label: state.label });
          }
        }
      }

      if (badges.length === 0) continue;
      badges.sort((a, b) => BADGE_URGENCY[a.kind] - BADGE_URGENCY[b.kind]);

      const latest = inAlerts
        ? [...human]
            .reverse()
            .find((m) => m.event_type === "message" && m.id !== openingMessageId && m.created_at >= windowStart && m.created_by !== personId)
        : undefined;

      addItem(personId, {
        queryId: thread.id,
        entityType: thread.entity_type,
        entityId: thread.entity_id,
        kind: thread.kind,
        badges,
        awaitingYou: isAwaitingUser(
          {
            ...thread.targeting,
            status: thread.status,
            created_by_id: thread.created_by,
            last_message_author_id: lastSpeaker?.created_by ?? null,
          },
          def,
          { id: person.id, role: person.role },
        ),
        latestReply: latest ? preview(latest.body) : null,
        neededBy: thread.needed_by,
        urgency: BADGE_URGENCY[badges[0].kind],
        createdAt: thread.created_at,
      });
    }
  }

  for (const items of byRecipient.values()) {
    items.sort((a, b) => a.urgency - b.urgency || a.createdAt.localeCompare(b.createdAt));
  }

  return { byRecipient, chased };
}
