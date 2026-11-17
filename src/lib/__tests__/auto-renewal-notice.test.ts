import { describe, expect, it } from "vitest";
import {
  buildNoticeDraft,
  isDueToSend,
  kindsToPrepare,
  noticeAttention,
  noticeRecipients,
  parseNoticeMode,
  renderNoticeHtml,
  sendDayFor,
  splitRecipientsForEnvironment,
  type NoticeDraftInput,
} from "@/lib/auto-renewal-notice";

const base: NoticeDraftInput = {
  kind: "notice",
  customer: "Acme Pvt Ltd",
  contractNumber: "TWV-C-0100",
  location: "MG Road",
  endDate: "2026-12-31",
  renewalStart: "2027-01-01",
  termMonths: 11,
  currentRent: 100000,
  newRent: 110000,
  escalationPercentage: 10,
  negotiated: false,
  noticeDeadline: "2026-10-31",
};

describe("parseNoticeMode", () => {
  it("never reads an unknown value as live", () => {
    expect(parseNoticeMode("live")).toBe("live");
    expect(parseNoticeMode("off")).toBe("off");
    expect(parseNoticeMode("yes")).toBe("dry_run");
    expect(parseNoticeMode(null)).toBe("dry_run");
  });
});

describe("noticeRecipients", () => {
  it("merges the customer and billing addresses, deduplicated, valid only", () => {
    expect(
      noticeRecipients({ email: "a@x.com", billing_emails: ["A@x.com", "b@x.com", "not-an-email", ""] }),
    ).toEqual(["a@x.com", "b@x.com"]);
    expect(noticeRecipients(null)).toEqual([]);
  });
});

describe("splitRecipientsForEnvironment", () => {
  it("lets production reach anyone", () => {
    expect(splitRecipientsForEnvironment(["a@real.com"], true)).toEqual({ allowed: ["a@real.com"], blocked: [] });
  });
  it("blocks everything except example.com off production", () => {
    expect(splitRecipientsForEnvironment(["a@real.com", "t@Example.com"], false)).toEqual({
      allowed: ["t@Example.com"],
      blocked: ["a@real.com"],
    });
  });
});

describe("buildNoticeDraft", () => {
  it("states the agreement's escalation and both rents", () => {
    const d = buildNoticeDraft(base);
    expect(d.subject).toBe("Your agreement at The WorkVilla renews on 1 January 2027");
    expect(d.body).toContain("clauses 18 and 19");
    expect(d.body).toContain("increasing by 10%");
    expect(d.body).toContain("₹1,00,000");
    expect(d.body).toContain("₹1,10,000");
    expect(d.body).toContain("31 October 2026");
  });

  it("says a negotiated rate applies to this term only, and does not cite the escalation", () => {
    const d = buildNoticeDraft({ ...base, negotiated: true, newRent: 105000, escalationPercentage: 5 });
    expect(d.body).toContain("this renewal term only");
    expect(d.body).not.toContain("increasing by");
  });

  it("writes the reminder with the date the rate was notified", () => {
    const d = buildNoticeDraft({ ...base, kind: "confirmation", notifiedOn: "2026-10-20" });
    expect(d.subject).toBe("Reminder: your agreement renews on 1 January 2027");
    expect(d.body).toContain("as notified on 20 October 2026");
    expect(d.body).toContain("No action is needed");
  });
});

describe("renderNoticeHtml", () => {
  it("escapes markup in an edited body and renders bullets", () => {
    const html = renderNoticeHtml("Hello <b>x</b>\n\n- one\n- two");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("<li");
  });
});

describe("noticeAttention", () => {
  it("is quiet with no notice or a cancelled one", () => {
    expect(noticeAttention("2026-10-01", null)).toBe("none");
    expect(noticeAttention("2026-10-01", { kind: "notice", status: "cancelled", sendOn: "2026-09-01" })).toBe("none");
  });
  it("asks for approval before the day, and calls it late after", () => {
    const draft = { kind: "notice" as const, status: "draft" as const, sendOn: "2026-10-10" };
    expect(noticeAttention("2026-10-09", draft)).toBe("needs_approval");
    expect(noticeAttention("2026-10-10", draft)).toBe("needs_approval");
    expect(noticeAttention("2026-10-11", draft)).toBe("late");
  });
  it("an approved notice is scheduled until its day passes unsent", () => {
    const approved = { kind: "notice" as const, status: "approved" as const, sendOn: "2026-10-10" };
    expect(noticeAttention("2026-10-09", approved)).toBe("scheduled");
    expect(noticeAttention("2026-10-11", approved)).toBe("late");
  });
  it("reports sent and failed", () => {
    expect(noticeAttention("2026-10-20", { kind: "notice", status: "sent", sendOn: "2026-10-10" })).toBe("sent");
    expect(noticeAttention("2026-10-20", { kind: "notice", status: "failed", sendOn: "2026-10-10" })).toBe("failed");
  });
});

describe("isDueToSend", () => {
  it("only an approved notice on or after its day", () => {
    expect(isDueToSend("2026-10-10", { status: "approved", sendOn: "2026-10-10" })).toBe(true);
    expect(isDueToSend("2026-10-09", { status: "approved", sendOn: "2026-10-10" })).toBe(false);
    expect(isDueToSend("2026-10-10", { status: "draft", sendOn: "2026-10-10" })).toBe(false);
    expect(isDueToSend("2026-10-10", { status: "sent", sendOn: "2026-10-01" })).toBe(false);
  });
});

describe("kindsToPrepare", () => {
  const schedule = { draftOn: "2026-10-03", confirmationOn: "2026-12-16" };
  it("drafts the rate notice from the draft day, once", () => {
    expect(kindsToPrepare("2026-10-02", schedule, "2026-12-31", false, [], false)).toEqual([]);
    expect(kindsToPrepare("2026-10-03", schedule, "2026-12-31", false, [], false)).toEqual(["notice"]);
    expect(kindsToPrepare("2026-10-04", schedule, "2026-12-31", false, ["notice"], false)).toEqual([]);
  });
  it("drafts the reminder only after the rate notice has gone out", () => {
    expect(kindsToPrepare("2026-11-01", schedule, "2026-12-31", false, ["notice"], false)).toEqual([]);
    expect(kindsToPrepare("2026-11-01", schedule, "2026-12-31", false, ["notice"], true)).toEqual(["confirmation"]);
  });
  it("drafts nothing for a held contract, a past term, or a schedule with no reminder", () => {
    expect(kindsToPrepare("2026-10-05", schedule, "2026-12-31", true, [], false)).toEqual([]);
    expect(kindsToPrepare("2027-01-02", schedule, "2026-12-31", false, [], false)).toEqual([]);
    expect(kindsToPrepare("2026-11-01", { draftOn: "2026-10-03", confirmationOn: null }, "2026-12-31", false, ["notice"], true)).toEqual([]);
  });
});

describe("sendDayFor", () => {
  it("sends the rate notice on notice #1 and the reminder on its own day", () => {
    const s = { noticeOn: "2026-10-10", confirmationOn: "2026-12-16" };
    expect(sendDayFor("notice", s)).toBe("2026-10-10");
    expect(sendDayFor("confirmation", s)).toBe("2026-12-16");
  });
});
