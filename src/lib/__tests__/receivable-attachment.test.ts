import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/mailer", () => ({ resend: { emails: { send: vi.fn() } }, EMAIL_FROM: "x", EMAIL_REPLY_TO: "x" }));
vi.mock("@/lib/whatsapp", () => ({ messaging: { paymentReminder: vi.fn() } }));
vi.mock("@/lib/app-settings-cache", () => ({ getCachedSettings: vi.fn() }));
vi.mock("@/lib/reminder-receivable-attachment", () => ({ fetchReceivableAttachment: vi.fn() }));
vi.mock("@/lib/payment-link-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/payment-link-guard")>()),
  ensureReceivableLink: vi.fn(),
}));

import { sendReceivableReminder, type ReceivableReminderInput } from "@/lib/receivable-reminder";
import { resend } from "@/lib/mailer";
import { fetchReceivableAttachment } from "@/lib/reminder-receivable-attachment";
import { ensureReceivableLink } from "@/lib/payment-link-guard";

const send = resend.emails.send as unknown as ReturnType<typeof vi.fn>;
const fetchAtt = fetchReceivableAttachment as unknown as ReturnType<typeof vi.fn>;
const ensureLink = ensureReceivableLink as unknown as ReturnType<typeof vi.fn>;

// Records inserts/updates; every chain resolves.
const admin = () => {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn().mockResolvedValue({});
  chain.update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({}) }));
  return { from: vi.fn(() => chain) } as never;
};

const input = (over: Partial<ReceivableReminderInput> = {}): ReceivableReminderInput => ({
  kind: "deposit", id: "p1", reference: "PROP-1", partyName: "Acme", email: "a@example.com", phone: null,
  amount: 120000, dueDate: "2026-10-24", daysOverdue: 3, stageIdx: 1, payLinkUrl: "https://rzp.io/l/x",
  triggeredBy: "cron", ccPools: { accounts: [], managerAndAdmin: [], adminOnly: [] }, ...over,
});

describe("sendReceivableReminder attachments", () => {
  beforeEach(() => {
  send.mockReset().mockResolvedValue({ error: null });
  fetchAtt.mockReset();
  ensureLink.mockReset().mockResolvedValue({ url: "https://rzp.io/l/x", createdAt: "2026-10-01T00:00:00.000Z", outcome: "live" });
});

  it("attaches the document and says so in the email", async () => {
    fetchAtt.mockResolvedValue({ filename: "d.pdf", content: Buffer.from("x"), contentType: "application/pdf", docNoun: "deposit request" });
    const r = await sendReceivableReminder(admin(), input());
    expect(r.emailSent).toBe(true);
    const arg = send.mock.calls[0][0];
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments[0].filename).toBe("d.pdf");
    expect(arg.html).toContain("The deposit request is attached.");
  });

  it("still sends, without a mention, when no document could be built", async () => {
    fetchAtt.mockResolvedValue(null);
    const r = await sendReceivableReminder(admin(), input());
    expect(r.emailSent).toBe(true);
    const arg = send.mock.calls[0][0];
    expect(arg.attachments).toBeUndefined();
    expect(arg.html).not.toContain("is attached");
  });

  it("calls an ad-hoc invoice a tax invoice once one is attached", async () => {
    fetchAtt.mockResolvedValue({ filename: "i.pdf", content: Buffer.from("x"), contentType: "application/pdf", docNoun: "tax invoice" });
    await sendReceivableReminder(admin(), input({ kind: "adhoc_invoice", stageIdx: 2, reference: "INV-1" }));
    const html = send.mock.calls[0][0].html as string;
    expect(html).toContain("tax invoice");
    expect(html).not.toMatch(/the proforma below/);
  });

  it("records the link that went out in the history", async () => {
    fetchAtt.mockResolvedValue(null);
    const inserts: Record<string, unknown>[][] = [];
    const a = { from: () => ({ insert: async (rows: Record<string, unknown>[]) => { inserts.push(rows); return {}; }, update: () => ({ eq: async () => ({}) }) }) } as never;
    await sendReceivableReminder(a, input());
    expect(inserts[0][0]).toMatchObject({ pay_link_url: "https://rzp.io/l/x", pay_link_outcome: "live", pay_link_created_at: "2026-10-01T00:00:00.000Z" });
  });

  it("sends no Pay button, and says to reply for a link, when no working link could be secured", async () => {
    fetchAtt.mockResolvedValue(null);
    ensureLink.mockResolvedValue({ url: null, createdAt: null, outcome: "unconfirmed" });
    const r = await sendReceivableReminder(admin(), input());
    expect(r.emailSent).toBe(true);
    expect(r.linkIssue).toBe(true);
    const html = send.mock.calls[0][0].html as string;
    expect(html).not.toContain("Pay Now");
    expect(html).toContain("Reply to this email and we'll send you a fresh one");
  });

  it("does not send at all when the link already shows a payment", async () => {
    ensureLink.mockResolvedValue({ url: null, createdAt: null, outcome: "paid" });
    const r = await sendReceivableReminder(admin(), input());
    expect(r.skipped).toMatch(/not reconciled/);
    expect(r.emailSent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("passes the stored link id so the link can be checked", async () => {
    fetchAtt.mockResolvedValue(null);
    await sendReceivableReminder(admin(), input({ payLinkId: "plink_1" }));
    expect(ensureLink.mock.calls[0][1]).toMatchObject({ linkId: "plink_1", linkUrl: "https://rzp.io/l/x" });
  });
});
