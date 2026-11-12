/**
 * Who a query is addressed to, whose turn it is, and who gets told.
 *
 * All pure functions — no Supabase, no mailer — so the routing rules are unit
 * testable (src/lib/__tests__/queries-audience.test.ts) and can be reused by
 * the client to render the "→ You" / "→ Sales" pill without a round trip.
 *
 * These replace two guesses in the original billing-queries implementation:
 *
 *   * isAwaitingViewer() inferred whose turn it was from the last speaker's
 *     role ("if accounts spoke last, it's awaiting everyone else"). With an
 *     explicit audience, it's a rule instead.
 *   * Every message notified all five roles in BILLING_QUERY_ROLES. Now the
 *     recipient list is the audience plus whoever is already in the thread.
 */

import type { UserRole } from "@/types";
import type { QueryEntityDef } from "./registry";
import type { QueryAudience, QueryStatus, QueryTargeting } from "./types";

/**
 * Roles that can read a thread but are never routed a question — asking
 * someone read-only to answer wastes their attention and yours. Applied
 * globally rather than curated per entity, since `viewer` is read-only
 * everywhere in the app.
 */
export const READ_ONLY_ROLES: readonly UserRole[] = ["viewer"];

export function isReadOnlyRole(role: string): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(role);
}

export interface Viewer {
  id: string;
  role: string;
}

/**
 * Can this person see the thread at all?
 *
 * Visibility follows the entity, never the audience: if you can open the
 * transaction, you can read questions raised on it. Targeting routes, it
 * doesn't hide.
 */
export function canSeeQuery(def: QueryEntityDef, viewer: Viewer, createdById?: string | null): boolean {
  // You can always read a thread you raised, whatever your role. Payment
  // reports made this load-bearing rather than merely fair: reporting is open
  // to every authenticated user, so an fms or IT technician passing on a
  // customer's payment screenshot would otherwise lose sight of their own
  // report the moment they sent it.
  if (createdById && createdById === viewer.id) return true;
  return (def.roles as readonly string[]).includes(viewer.role);
}

/**
 * Is this person in the addressed audience — i.e. is the question aimed at
 * them? `all` means everyone authorized on the entity who could actually act
 * on it.
 */
export function isInAudience(query: QueryTargeting, def: QueryEntityDef, viewer: Viewer): boolean {
  switch (query.audience) {
    case "users":
      return query.audience_user_ids.includes(viewer.id);
    case "roles":
      return (query.audience_roles as readonly string[]).includes(viewer.role);
    case "all":
      return canSeeQuery(def, viewer) && !isReadOnlyRole(viewer.role);
    default:
      return false;
  }
}

export interface AwaitingInput extends QueryTargeting {
  status: QueryStatus;
  created_by_id: string;
  /** Author of the most recent message, or null for a thread with none. */
  last_message_author_id: string | null;
}

/**
 * Is the ball in this person's court?
 *
 * Three cases, in order:
 *   1. Resolved threads await nobody.
 *   2. If you spoke last, you're waiting on someone else, not the reverse.
 *   3. Otherwise it awaits the asker (a reply came back to them) or anyone
 *      in the addressed audience (they owe an answer).
 */
export function isAwaitingUser(query: AwaitingInput, def: QueryEntityDef, viewer: Viewer): boolean {
  if (query.status !== "open") return false;
  if (query.last_message_author_id === viewer.id) return false;
  if (query.created_by_id === viewer.id) return true;
  return isInAudience(query, def, viewer);
}

/** How the audience pill reads on a card. */
export function audienceLabel(
  query: QueryTargeting,
  viewer: Viewer,
  roleLabel: (role: string) => string,
  userName: (id: string) => string,
): string {
  if (query.audience === "users") {
    if (query.audience_user_ids.includes(viewer.id) && query.audience_user_ids.length === 1) return "You";
    return query.audience_user_ids.map(userName).join(", ");
  }
  if (query.audience === "roles") {
    return query.audience_roles.map(roleLabel).join(", ");
  }
  return "Anyone who can help";
}

export interface CandidateUser {
  id: string;
  role: string;
  is_active?: boolean;
}

export interface RecipientSets {
  /** In-app notification + push. */
  notify: string[];
  /** Additionally emailed / WhatsApp-escalated. A subset of notify. */
  alert: string[];
}

/**
 * Who hears about a message on this thread.
 *
 * notify = the addressed audience, plus anyone already in the conversation,
 * minus whoever just posted. Including prior participants matters: without
 * it, re-targeting a thread silently drops the person who has been answering
 * it, and resolving drops the asker.
 *
 * alert (email / WhatsApp) narrows an untargeted `all` broadcast to the
 * entity's alertRoles — admin and office_admin monitor rather than answer, so
 * they don't get paged for every question. An *explicit* audience overrides
 * that: if the asker named you or your role, you get the email regardless,
 * because being addressed by name is the whole point of targeting.
 */
export function resolveRecipients(params: {
  query: QueryTargeting;
  def: QueryEntityDef;
  candidates: CandidateUser[];
  /** Everyone who has already posted in the thread, including the creator. */
  participantIds: string[];
  /** Whoever just acted — never notified about their own message. */
  authorId: string;
}): RecipientSets {
  const { query, def, candidates, participantIds, authorId } = params;

  const active = candidates.filter((c) => c.is_active !== false);
  const byId = new Map(active.map((c) => [c.id, c]));

  const addressed = active.filter((c) => isInAudience(query, def, { id: c.id, role: c.role }));

  // Prior participants stay in the loop even once they fall outside the
  // current audience (e.g. after a re-target).
  const participants = participantIds
    .map((id) => byId.get(id))
    .filter((c): c is CandidateUser => !!c);

  const notifyIds = new Set([...addressed, ...participants].map((c) => c.id));
  notifyIds.delete(authorId);

  const explicitlyTargeted = query.audience !== "all";
  const alertIds = new Set(
    [...notifyIds].filter((id) => {
      const user = byId.get(id);
      if (!user || isReadOnlyRole(user.role)) return false;
      if (explicitlyTargeted) return true;
      return (def.alertRoles as readonly string[]).includes(user.role);
    }),
  );

  return { notify: [...notifyIds], alert: [...alertIds] };
}

/** Validate a targeting payload coming off the wire. */
export function validateTargeting(input: {
  audience?: string;
  audience_roles?: unknown;
  audience_user_ids?: unknown;
}): { ok: true; value: QueryTargeting } | { ok: false; error: string } {
  const audience = (input.audience ?? "all") as QueryAudience;
  if (!["all", "roles", "users"].includes(audience)) {
    return { ok: false, error: "audience must be one of: all, roles, users" };
  }

  const roles = Array.isArray(input.audience_roles)
    ? (input.audience_roles.filter((r): r is string => typeof r === "string") as UserRole[])
    : [];
  const userIds = Array.isArray(input.audience_user_ids)
    ? input.audience_user_ids.filter((r): r is string => typeof r === "string")
    : [];

  if (audience === "roles" && roles.length === 0) {
    return { ok: false, error: "Pick at least one role to ask." };
  }
  if (audience === "users" && userIds.length === 0) {
    return { ok: false, error: "Pick at least one person to ask." };
  }

  return {
    ok: true,
    value: {
      audience,
      // Only persist the arm that's in play, so a query can't carry stale
      // targets from a mind change in the composer.
      audience_roles: audience === "roles" ? roles : [],
      audience_user_ids: audience === "users" ? userIds : [],
    },
  };
}
