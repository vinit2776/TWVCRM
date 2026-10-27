import { describe, it, expect, vi } from "vitest";

// payment-reminder pulls in the mailer, which warns about missing SMTP env at import.
vi.mock("@/lib/mailer", () => ({ resend: {}, EMAIL_FROM: "x", EMAIL_REPLY_TO: "x" }));
vi.mock("@/lib/whatsapp", () => ({ messaging: {} }));
vi.mock("@/lib/app-settings-cache", () => ({ getCachedSettings: vi.fn() }));

import { renderConsolidatedEmail, type ConsolidatedItem } from "@/lib/payment-reminder";

const item = (ref: string, due: string, days: number, balance: number, paid = 0, link: string | null = "https://rzp.io/l/x"): ConsolidatedItem => ({
  statement: { id: ref }, ref, contractRef: "TWV-C-0123", dueStr: due, daysOverdue: days,
  balance, paid, billed: balance + paid, payLinkUrl: link,
});

const base = {
  customerName: "Acme", intro: "The payment for the invoices below is now overdue.",
  toneLabel: "Firm reminder", totalStr: "1,48,500", oldestDays: 37,
  omittedAttachments: 0, showContract: false, trackingPixelUrl: null,
};

describe("renderConsolidatedEmail", () => {
  const items = [item("INV-31", "20 Sep 2026", 37, 29500, 29500), item("INV-36", "5 Oct 2026", 22, 60000), item("INV-42", "20 Oct 2026", 7, 59000)];

  it("shows the total as the amount due with every invoice in the breakdown", () => {
    const html = renderConsolidatedEmail({ ...base, items });
    expect(html).toContain("Rs. 1,48,500");
    for (const r of ["INV-31", "INV-36", "INV-42"]) expect(html).toContain(r);
    expect(html).toContain("Oldest invoice is 37 days past due");
    expect(html).toContain("Rs. 59,000 billed, Rs. 29,500 paid");
  });

  it("gives each invoice its own Pay link, and none where there is no link", () => {
    const html = renderConsolidatedEmail({ ...base, items: [items[0], item("INV-NOLINK", "1 Oct", 5, 100, 0, null)] });
    expect(html.match(/>Pay<\/a>/g)).toHaveLength(1);
  });

  it("notes the invoices that could not be attached", () => {
    const html = renderConsolidatedEmail({ ...base, items, omittedAttachments: 2 });
    expect(html).toContain("reply to this email for a copy of the other 2");
    expect(html).not.toContain("each invoice is attached");
  });

  it("shows the contract only when invoices span several", () => {
    expect(renderConsolidatedEmail({ ...base, items, showContract: true })).toContain("TWV-C-0123");
    expect(renderConsolidatedEmail({ ...base, items })).not.toContain("TWV-C-0123");
  });
});
