import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/mailer", () => ({ resend: { emails: { send: vi.fn() } }, EMAIL_FROM: "x", EMAIL_REPLY_TO: "x" }));
vi.mock("@/lib/whatsapp", () => ({ messaging: { paymentReminder: vi.fn() } }));
vi.mock("@/lib/app-settings-cache", () => ({ getCachedSettings: vi.fn() }));
vi.mock("@/lib/reminder-receivable-attachment", () => ({ fetchReceivableAttachment: vi.fn() }));

import { sendReceivableReminder, type ReceivableReminderInput } from "@/lib/receivable-reminder";
import { resend } from "@/lib/mailer";
import { fetchReceivableAttachment } from "@/lib/reminder-receivable-attachment";

const send = resend.emails.send as unknown as ReturnType<typeof vi.fn>;
const fetchAtt = fetchReceivableAttachment as unknown as ReturnType<typeof vi.fn>;

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
  beforeEach(() => { send.mockReset().mockResolvedValue({ error: null }); fetchAtt.mockReset(); });

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
});
