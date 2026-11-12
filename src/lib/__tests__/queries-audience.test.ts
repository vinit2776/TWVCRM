import { describe, it, expect } from "vitest";
import {
  canSeeQuery,
  isInAudience,
  isAwaitingUser,
  resolveRecipients,
  validateTargeting,
  READ_ONLY_ROLES,
  type Viewer,
} from "@/lib/queries/audience";
import { QUERY_ENTITIES, type QueryEntityDef } from "@/lib/queries/registry";
import { QUERY_ENTITY_TYPES, type QueryTargeting } from "@/lib/queries/types";

/**
 * The routing rules for query threads. These replace two heuristics in the
 * original billing-queries implementation ("if accounts spoke last it's
 * awaiting everyone else", and notifying all five roles on every message),
 * so they're worth pinning down.
 */

// A stand-in entity: authorized for four roles, only two of which get paged,
// plus a read-only role that can look but is never asked.
const DEF = {
  type: "billing_statement",
  label: "Statement",
  module: "billing",
  table: "billing_statements",
  select: "id",
  roles: ["accounts", "manager", "sales_rep", "admin", "viewer"],
  alertRoles: ["accounts", "manager", "sales_rep"],
  templates: [],
  auditEntityType: "billing_statement",
  auditEntityId: () => null,
  toSummary: () => null,
} as unknown as QueryEntityDef;

const ALL: QueryTargeting = { audience: "all", audience_roles: [], audience_user_ids: [] };
const TO_SALES: QueryTargeting = { audience: "roles", audience_roles: ["sales_rep"], audience_user_ids: [] };
const TO_PRIYA: QueryTargeting = { audience: "users", audience_roles: [], audience_user_ids: ["priya"] };

const meera: Viewer = { id: "meera", role: "accounts" };
const priya: Viewer = { id: "priya", role: "sales_rep" };
const arun: Viewer = { id: "arun", role: "manager" };
const vinit: Viewer = { id: "vinit", role: "admin" };
const raj: Viewer = { id: "raj", role: "viewer" };
const fms: Viewer = { id: "fms", role: "fms" };

describe("canSeeQuery — targeting routes, it never hides", () => {
  it("lets every authorized role read the thread", () => {
    for (const v of [meera, priya, arun, vinit, raj]) {
      expect(canSeeQuery(DEF, v)).toBe(true);
    }
  });

  it("excludes roles with no access to the entity at all", () => {
    expect(canSeeQuery(DEF, fms)).toBe(false);
  });

  it("still lets non-addressed people read a query aimed at one person", () => {
    expect(canSeeQuery(DEF, arun)).toBe(true);
    expect(isInAudience(TO_PRIYA, DEF, arun)).toBe(false);
  });
});

describe("isInAudience", () => {
  it("'all' means every authorized role that can actually act", () => {
    expect(isInAudience(ALL, DEF, priya)).toBe(true);
    expect(isInAudience(ALL, DEF, arun)).toBe(true);
  });

  it("'all' excludes read-only roles — never ask someone who can't answer", () => {
    expect(isInAudience(ALL, DEF, raj)).toBe(false);
  });

  it("'all' excludes roles unauthorized on the entity", () => {
    expect(isInAudience(ALL, DEF, fms)).toBe(false);
  });

  it("'roles' matches on role", () => {
    expect(isInAudience(TO_SALES, DEF, priya)).toBe(true);
    expect(isInAudience(TO_SALES, DEF, arun)).toBe(false);
  });

  it("'users' matches on id, regardless of role", () => {
    expect(isInAudience(TO_PRIYA, DEF, priya)).toBe(true);
    expect(isInAudience(TO_PRIYA, DEF, vinit)).toBe(false);
  });
});

describe("isAwaitingUser", () => {
  const base = { ...ALL, status: "open" as const, created_by_id: "meera" };

  it("awaits nobody once resolved", () => {
    expect(
      isAwaitingUser({ ...base, status: "resolved", last_message_author_id: "meera" }, DEF, priya),
    ).toBe(false);
  });

  it("does not await whoever spoke last", () => {
    expect(isAwaitingUser({ ...base, last_message_author_id: "priya" }, DEF, priya)).toBe(false);
  });

  it("awaits the audience when the asker spoke last", () => {
    expect(isAwaitingUser({ ...base, last_message_author_id: "meera" }, DEF, priya)).toBe(true);
    expect(isAwaitingUser({ ...base, last_message_author_id: "meera" }, DEF, arun)).toBe(true);
  });

  it("returns the ball to the asker once someone replies", () => {
    expect(isAwaitingUser({ ...base, last_message_author_id: "priya" }, DEF, meera)).toBe(true);
  });

  it("awaits only the named person when the query is targeted", () => {
    const targeted = { ...TO_PRIYA, status: "open" as const, created_by_id: "meera", last_message_author_id: "meera" };
    expect(isAwaitingUser(targeted, DEF, priya)).toBe(true);
    expect(isAwaitingUser(targeted, DEF, arun)).toBe(false);
    // The asker is still waiting on an answer, not on themselves.
    expect(isAwaitingUser(targeted, DEF, meera)).toBe(false);
  });

  it("never awaits a read-only viewer", () => {
    expect(isAwaitingUser({ ...base, last_message_author_id: "meera" }, DEF, raj)).toBe(false);
  });
});

describe("resolveRecipients", () => {
  const candidates = [
    { id: "meera", role: "accounts" },
    { id: "priya", role: "sales_rep" },
    { id: "arun", role: "manager" },
    { id: "vinit", role: "admin" },
    { id: "raj", role: "viewer" },
    { id: "fms", role: "fms" },
    { id: "gone", role: "manager", is_active: false },
  ];

  it("notifies the audience but never the author", () => {
    const { notify } = resolveRecipients({
      query: ALL,
      def: DEF,
      candidates,
      participantIds: ["meera"],
      authorId: "meera",
    });
    expect(notify).not.toContain("meera");
    expect(notify).toEqual(expect.arrayContaining(["priya", "arun", "vinit"]));
  });

  it("excludes unauthorized roles, read-only roles and inactive users", () => {
    const { notify } = resolveRecipients({
      query: ALL,
      def: DEF,
      candidates,
      participantIds: [],
      authorId: "meera",
    });
    expect(notify).not.toContain("fms");
    expect(notify).not.toContain("raj");
    expect(notify).not.toContain("gone");
  });

  it("pages only alertRoles on an untargeted broadcast — admin monitors, isn't paged", () => {
    const { notify, alert } = resolveRecipients({
      query: ALL,
      def: DEF,
      candidates,
      participantIds: [],
      authorId: "meera",
    });
    expect(notify).toContain("vinit");
    expect(alert).not.toContain("vinit");
    expect(alert).toEqual(expect.arrayContaining(["priya", "arun"]));
  });

  it("pages anyone named explicitly, even outside alertRoles", () => {
    const { alert } = resolveRecipients({
      query: { audience: "users", audience_roles: [], audience_user_ids: ["vinit"] },
      def: DEF,
      candidates,
      participantIds: [],
      authorId: "meera",
    });
    expect(alert).toContain("vinit");
  });

  it("keeps prior participants in the loop after a re-target", () => {
    // Originally asked of sales; now aimed at Arun. Priya has already
    // replied, so dropping her would orphan the conversation she is in.
    const { notify } = resolveRecipients({
      query: { audience: "users", audience_roles: [], audience_user_ids: ["arun"] },
      def: DEF,
      candidates,
      participantIds: ["meera", "priya"],
      authorId: "arun",
    });
    expect(notify).toEqual(expect.arrayContaining(["meera", "priya"]));
  });

  it("notifies the asker when someone else resolves their query", () => {
    const { notify } = resolveRecipients({
      query: TO_PRIYA,
      def: DEF,
      candidates,
      participantIds: ["meera", "priya"],
      authorId: "priya",
    });
    expect(notify).toContain("meera");
  });
});

describe("registry invariants", () => {
  const entries = QUERY_ENTITY_TYPES.map((t) => [t, QUERY_ENTITIES[t]] as const);

  it("registers every declared entity type", () => {
    for (const [type, def] of entries) {
      expect(def, `${type} missing from QUERY_ENTITIES`).toBeDefined();
      expect(def.type).toBe(type);
    }
  });

  it.each(entries)("%s: alertRoles is a subset of roles", (type, def) => {
    // Alerts ⊆ notified ⊆ audience, and for audience 'all' the audience is
    // `roles`. A role listed only in alertRoles can therefore never be paged
    // — it silently does nothing, which is how the first draft of the Tally
    // Inbox entries shipped floor_manager and sales_rep as dead entries.
    const orphans = def.alertRoles.filter((r) => !def.roles.includes(r));
    expect(orphans, `${type}: alertRoles not in roles`).toEqual([]);
  });

  it.each(entries)("%s: alertRoles contains no read-only role", (type, def) => {
    const readOnly = def.alertRoles.filter((r) => (READ_ONLY_ROLES as readonly string[]).includes(r));
    expect(readOnly, `${type}: read-only roles can't answer, so can't be paged`).toEqual([]);
  });

  it.each(entries)("%s: has at least one askable role and one template", (type, def) => {
    const askable = def.roles.filter((r) => !(READ_ONLY_ROLES as readonly string[]).includes(r));
    expect(askable.length, `${type}: nobody could ever be asked`).toBeGreaterThan(0);
    expect(def.templates.length, `${type}: no canned asks`).toBeGreaterThan(0);
  });

  it.each(entries)("%s: toSummary tolerates a missing row", (type, def) => {
    // (entity_type, entity_id) carries no FK, so a deleted entity must render
    // as "no longer available" rather than throwing.
    expect(() => def.toSummary({})).not.toThrow();
    expect(def.toSummary({})).toBeNull();
  });
});

describe("validateTargeting", () => {
  it("defaults to 'all'", () => {
    const result = validateTargeting({});
    expect(result.ok && result.value.audience).toBe("all");
  });

  it("rejects an empty role or people selection", () => {
    expect(validateTargeting({ audience: "roles", audience_roles: [] }).ok).toBe(false);
    expect(validateTargeting({ audience: "users", audience_user_ids: [] }).ok).toBe(false);
  });

  it("rejects an unknown audience", () => {
    expect(validateTargeting({ audience: "everyone" }).ok).toBe(false);
  });

  it("drops the arm that isn't in play, so a mind change can't leave stale targets", () => {
    const result = validateTargeting({
      audience: "roles",
      audience_roles: ["sales_rep"],
      audience_user_ids: ["priya"],
    });
    expect(result.ok && result.value.audience_user_ids).toEqual([]);
  });
});
