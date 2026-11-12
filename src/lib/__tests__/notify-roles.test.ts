import { describe, it, expect, vi, beforeEach } from "vitest";

const sendPushToUsers = vi.fn();
vi.mock("@/lib/push", () => ({ sendPushToUsers: (...a: unknown[]) => sendPushToUsers(...a) }));

import { notifyRoles } from "../notify-roles";

/** A stand-in Supabase client whose users query returns ids by the role asked for. */
function fakeSupabase(byRole: Record<string, string[]>) {
  return {
    from: () => ({
      select: () => ({
        in: (_col: string, roles: string[]) => ({
          eq: async () => ({ data: roles.flatMap((r) => (byRole[r] ?? []).map((id) => ({ id }))) }),
        }),
      }),
    }),
  } as never;
}

beforeEach(() => sendPushToUsers.mockReset().mockResolvedValue(1));

describe("notifyRoles", () => {
  it("pushes only to people holding the owning role", async () => {
    await notifyRoles(fakeSupabase({ accounts: ["a1", "a2"], manager: ["m1"] }), ["accounts"], { title: "t", body: "b" });
    expect(sendPushToUsers).toHaveBeenCalledWith(["a1", "a2"], { title: "t", body: "b" });
  });
  it("falls back to managers and admins when nobody holds the role", async () => {
    await notifyRoles(fakeSupabase({ manager: ["m1"], admin: ["ad1"] }), ["floor_manager"], { title: "t", body: "b" });
    expect(sendPushToUsers).toHaveBeenCalledWith(["m1", "ad1"], { title: "t", body: "b" });
  });
});
