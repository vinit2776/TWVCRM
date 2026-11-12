import { describe, it, expect, vi, beforeEach } from "vitest";

const sendWhatsApp = vi.fn();
vi.mock("@/lib/whatsapp", () => ({ sendWhatsApp: (...a: unknown[]) => sendWhatsApp(...a) }));

import { cleanReplyText, complaintTemplateStatus, firstNameOf, ratingUrl, sendComplaintReply } from "../complaint-messages";

/** A tiny in-memory stand-in for the Supabase client: one complaint, a reply log. */
function fakeAdmin(replies: { kind: string; status: string }[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const complaint = { reference: "CMP-0007", customer_name: "Rahul S.", customer_phone: "9000000301", lead_id: "lead-1" };
  const admin = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain, eq: chain, limit: chain,
        single: async () => ({ data: complaint }),
        maybeSingle: async () => ({ data: replies.find((r) => r.status === "sent") ? { id: "x" } : null }),
        insert: async (row: Record<string, unknown>) => { if (table === "complaint_replies") inserted.push(row); return { error: null }; },
      });
      return q;
    },
  };
  return { admin: admin as never, inserted };
}

beforeEach(() => {
  sendWhatsApp.mockReset();
  delete process.env.MSG91_WA_TEMPLATE_COMPLAINT_RECEIVED;
  delete process.env.MSG91_WA_TEMPLATE_COMPLAINT_UPDATE;
  delete process.env.MSG91_WA_TEMPLATE_COMPLAINT_RESOLVED;
});

describe("helpers", () => {
  it("firstNameOf", () => {
    expect(firstNameOf("Rahul S.")).toBe("Rahul");
    expect(firstNameOf("  ")).toBe("there");
    expect(firstNameOf(null)).toBe("there");
  });
  it("cleanReplyText collapses whitespace and caps length", () => {
    expect(cleanReplyText("Visit\n by   3 pm")).toBe("Visit by 3 pm");
    expect(cleanReplyText("x".repeat(500)).length).toBe(300);
  });
  it("ratingUrl needs a token", () => {
    expect(ratingUrl(null)).toBeNull();
    expect(ratingUrl("abc")).toContain("/facility/satisfaction/abc");
  });
  it("template status follows the env vars", () => {
    expect(complaintTemplateStatus()).toEqual({ received: false, update: false, resolved: false });
    process.env.MSG91_WA_TEMPLATE_COMPLAINT_UPDATE = " complaint_update\n";
    expect(complaintTemplateStatus().update).toBe(true);
  });
});

describe("sendComplaintReply", () => {
  it("is skipped, not an error, when the template is not configured", async () => {
    const { admin, inserted } = fakeAdmin();
    const r = await sendComplaintReply(admin, { complaintId: "c1", kind: "received" });
    expect(r).toEqual({ status: "skipped", detail: "template not configured" });
    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ kind: "received", status: "skipped" });
  });
  it("sends the update template with first name, reference and the cleaned text, and logs it", async () => {
    process.env.MSG91_WA_TEMPLATE_COMPLAINT_UPDATE = "complaint_update";
    sendWhatsApp.mockResolvedValue({ success: true, channel: "whatsapp" });
    const { admin, inserted } = fakeAdmin();
    const r = await sendComplaintReply(admin, { complaintId: "c1", kind: "update", text: "Visit\n by 3 pm", sentBy: "u1" });
    expect(r.status).toBe("sent");
    expect(sendWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ template: "complaint_update", params: ["Rahul", "CMP-0007", "Visit by 3 pm"], entityType: "lead", entityId: "lead-1" }));
    expect(inserted[0]).toMatchObject({ kind: "update", status: "sent", message: "Visit by 3 pm", sent_by: "u1" });
  });
  it("records a failure with MSG91's reason", async () => {
    process.env.MSG91_WA_TEMPLATE_COMPLAINT_RECEIVED = "complaint_received";
    sendWhatsApp.mockResolvedValue({ success: false, error: "HTTP 401: bad key", channel: "whatsapp" });
    const { admin, inserted } = fakeAdmin();
    expect(await sendComplaintReply(admin, { complaintId: "c1", kind: "received" })).toEqual({ status: "failed", detail: "HTTP 401: bad key" });
    expect(inserted[0]).toMatchObject({ status: "failed", detail: "HTTP 401: bad key" });
  });
  it("sends the acknowledgement and the closing message only once", async () => {
    process.env.MSG91_WA_TEMPLATE_COMPLAINT_RESOLVED = "complaint_resolved";
    const { admin } = fakeAdmin([{ kind: "resolved", status: "sent" }]);
    expect(await sendComplaintReply(admin, { complaintId: "c1", kind: "resolved", ratingLink: "https://x/y" })).toEqual({ status: "skipped", detail: "already sent" });
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });
  it("won't send the closing message without a rating link, or an update with no text", async () => {
    process.env.MSG91_WA_TEMPLATE_COMPLAINT_RESOLVED = "complaint_resolved";
    process.env.MSG91_WA_TEMPLATE_COMPLAINT_UPDATE = "complaint_update";
    const { admin } = fakeAdmin();
    expect((await sendComplaintReply(admin, { complaintId: "c1", kind: "resolved", ratingLink: null })).detail).toBe("no rating link");
    expect((await sendComplaintReply(admin, { complaintId: "c1", kind: "update", text: "  " })).detail).toBe("no message");
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });
});
