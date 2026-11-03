import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/app-settings-cache", () => ({
  getCachedSettings: vi.fn(async () => ({ razorpay_enabled: "true", razorpay_key_id: "k", razorpay_key_secret: "s" })),
}));

import { getCachedSettings } from "@/lib/app-settings-cache";
import {
  classifyLinkStatus, buildReplacementPayload, ensureLiveLink, ensureReceivableLink, insertReminderHistory,
  type EnsureLinkParams,
} from "@/lib/payment-link-guard";
import { RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";

type Update = { table: string; values: Record<string, unknown> };

/** Admin client double: records every update; every chain resolves without error. */
function fakeAdmin() {
  const updates: Update[] = [];
  const from = (table: string) => ({
    update: (values: Record<string, unknown>) => {
      updates.push({ table, values });
      const c: Record<string, unknown> = {};
      c.eq = () => c; c.is = () => c;
      c.then = (res: (v: { error: null }) => unknown) => res({ error: null });
      return c;
    },
  });
  return { admin: { from } as never, updates };
}

const base: EnsureLinkParams = {
  kind: "deposit", rowId: "row1", linkId: "plink_old", linkUrl: "https://rzp.io/l/old",
  amountRupees: 1200, reference: "PROP-0412", description: "Security Deposit — PROP-0412",
  customer: { name: "Acme", email: "a@example.com" }, notes: { type: "security_deposit" },
  callbackUrl: "https://crm.example/proposals", createIfMissing: false,
};

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("classifyLinkStatus", () => {
  it("maps Razorpay statuses", () => {
    expect(classifyLinkStatus("created")).toBe("live");
    expect(classifyLinkStatus("paid")).toBe("paid");
    expect(classifyLinkStatus("partially_paid")).toBe("paid");
    expect(classifyLinkStatus("expired")).toBe("dead");
    expect(classifyLinkStatus("cancelled")).toBe("dead");
    expect(classifyLinkStatus("something_new")).toBe("unknown");
    expect(classifyLinkStatus(undefined)).toBe("unknown");
  });
});

describe("buildReplacementPayload", () => {
  const old = {
    description: "Original description", notes: { type: "deposit_topup", contract_id: "c1" },
    customer: { name: "Old Name", email: "old@example.com" }, callback_url: "https://crm.example/contracts/c1",
  };

  it("clones the dead link, with a fresh reference, expiry and no notifications", () => {
    const p = buildReplacementPayload({ old, amountRupees: 30000, reference: "TWV-C-0123", description: "x", callbackUrl: "https://fallback", nowMs: 1_800_000_000_000 });
    expect(p.amount).toBe(3000000);
    expect(p.description).toBe("Original description");
    expect(p.customer).toEqual(old.customer);
    expect(p.callback_url).toBe("https://crm.example/contracts/c1");
    expect(p.notify).toEqual({ sms: false, email: false });
    expect(p.expire_by).toBe(1_800_000_000 + RAZORPAY_MAX_LINK_VALIDITY_SECONDS);
    expect(p.notes).toMatchObject({ type: "deposit_topup", contract_id: "c1", regenerated: "true" });
    expect(String(p.reference_id)).toMatch(/^TWV-C-0123-RG\d+$/);
  });

  it("keeps reference_id within Razorpay's 40 characters", () => {
    const p = buildReplacementPayload({ old: null, amountRupees: 1, reference: "A-VERY-LONG-REFERENCE-NUMBER-THAT-GOES-ON-AND-ON", description: "d", callbackUrl: "u", nowMs: 1_800_000_000_000 });
    expect(String(p.reference_id).length).toBeLessThanOrEqual(40);
  });

  it("falls back to the given details when the old link cannot be read", () => {
    const p = buildReplacementPayload({ old: null, amountRupees: 500, reference: "INV-1", description: "Fallback", customer: { name: "Acme" }, notes: { a: "b" }, callbackUrl: "https://cb", nowMs: 1_800_000_000_000 });
    expect(p.description).toBe("Fallback");
    expect(p.customer).toEqual({ name: "Acme" });
    expect(p.callback_url).toBe("https://cb");
    expect(p.notes).toMatchObject({ a: "b", regenerated: "true" });
  });
});

describe("ensureLiveLink", () => {
  it("returns a live link as is, records its dates, and creates nothing", async () => {
    const { admin, updates } = fakeAdmin();
    fetchMock.mockResolvedValueOnce(json({ status: "created", short_url: "https://rzp.io/l/old", created_at: 1_790_000_000, expire_by: 1_800_000_000 }));
    const r = await ensureLiveLink(admin, base);
    expect(r).toMatchObject({ url: "https://rzp.io/l/old", outcome: "live" });
    expect(r.createdAt).toBe(new Date(1_790_000_000 * 1000).toISOString());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updates[0]).toMatchObject({ table: "proposals", values: { deposit_razorpay_link_created_at: r.createdAt } });
  });

  it("replaces an expired link with a saved replacement of the same amount", async () => {
    const { admin, updates } = fakeAdmin();
    fetchMock
      .mockResolvedValueOnce(json({ status: "expired", description: "Orig", notes: { type: "security_deposit" } }))
      .mockResolvedValueOnce(json({ id: "plink_new", short_url: "https://rzp.io/l/new", created_at: 1_795_000_000, expire_by: 1_810_000_000 }));
    const r = await ensureLiveLink(admin, base);
    expect(r).toMatchObject({ url: "https://rzp.io/l/new", outcome: "regenerated" });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(body.amount).toBe(120000);
    expect(body.notify).toEqual({ sms: false, email: false });
    expect(updates[0]).toMatchObject({ table: "proposals", values: { deposit_razorpay_link_id: "plink_new", deposit_razorpay_link_url: "https://rzp.io/l/new" } });
  });

  it("also points an ad-hoc invoice's statement at the replacement", async () => {
    const { admin, updates } = fakeAdmin();
    fetchMock
      .mockResolvedValueOnce(json({ status: "cancelled" }))
      .mockResolvedValueOnce(json({ id: "plink_new", short_url: "https://rzp.io/l/new", created_at: 1_795_000_000, expire_by: 1_810_000_000 }));
    await ensureLiveLink(admin, { ...base, kind: "adhoc_invoice" });
    expect(updates.some((u) => u.table === "proforma_invoices" && u.values.razorpay_link_id === "plink_new")).toBe(true);
    expect(updates.some((u) => u.table === "billing_statements" && u.values.razorpay_payment_link_id === "plink_new")).toBe(true);
  });

  it("neither chases nor replaces a link that shows a payment", async () => {
    const { admin, updates } = fakeAdmin();
    fetchMock.mockResolvedValueOnce(json({ status: "partially_paid" }));
    const r = await ensureLiveLink(admin, base);
    expect(r).toMatchObject({ url: null, outcome: "paid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(0);
  });

  it("does not make a second link when the status cannot be read", async () => {
    const { admin, updates } = fakeAdmin();
    fetchMock.mockResolvedValueOnce(json({}, false));
    expect(await ensureLiveLink(admin, base)).toMatchObject({ url: null, outcome: "unconfirmed" });
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    expect(await ensureLiveLink(admin, base)).toMatchObject({ url: null, outcome: "unconfirmed" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(0);
  });

  it("sends no link, rather than a dead one, when the replacement is refused", async () => {
    const { admin } = fakeAdmin();
    fetchMock.mockResolvedValueOnce(json({ status: "expired" })).mockResolvedValueOnce(json({ error: "no" }, false));
    expect(await ensureLiveLink(admin, base)).toMatchObject({ url: null, outcome: "unconfirmed" });
  });

  it("keeps a manual receivable without a link as it is, but makes one for a statement", async () => {
    const { admin } = fakeAdmin();
    expect(await ensureLiveLink(admin, { ...base, linkId: null, linkUrl: null })).toMatchObject({ url: null, outcome: "none" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ id: "plink_new", short_url: "https://rzp.io/l/new", created_at: 1_795_000_000, expire_by: 1_810_000_000 }));
    const r = await ensureLiveLink(admin, { ...base, kind: "statement", linkId: null, linkUrl: null, createIfMissing: true });
    expect(r).toMatchObject({ url: "https://rzp.io/l/new", outcome: "regenerated" });
  });

  it("does nothing when Razorpay is switched off", async () => {
    const { admin } = fakeAdmin();
    (getCachedSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ razorpay_enabled: "false" });
    expect(await ensureLiveLink(admin, base)).toMatchObject({ url: "https://rzp.io/l/old", outcome: "disabled" });
    (getCachedSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ razorpay_enabled: "false" });
    expect(await ensureLiveLink(admin, { ...base, kind: "statement" })).toMatchObject({ url: null, outcome: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ensureReceivableLink", () => {
  it("never invents a link for a top-up collected manually", async () => {
    const { admin } = fakeAdmin();
    const r = await ensureReceivableLink(admin, {
      kind: "topup", id: "t1", reference: "TWV-C-0123", amount: 30000, partyName: "Acme", email: null, phone: null,
      linkId: null, linkUrl: null, appUrl: "https://crm.example",
    });
    expect(r.outcome).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("insertReminderHistory", () => {
  it("writes the rows without the link columns when the database does not have them yet", async () => {
    const insert = vi.fn()
      .mockResolvedValueOnce({ error: { message: 'column "pay_link_url" of relation "x" does not exist' } })
      .mockResolvedValueOnce({ error: null });
    const admin = { from: () => ({ insert }) } as never;
    await insertReminderHistory(admin, "billing_reminder_sends", [{ channel: "email", pay_link_url: "u", pay_link_created_at: null, pay_link_outcome: "live" }]);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[1][0][0]).toEqual({ channel: "email" });
  });

  it("does not retry on an unrelated error", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: "permission denied" } });
    await insertReminderHistory({ from: () => ({ insert }) } as never, "receivable_reminder_sends", [{ channel: "email" }]);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
