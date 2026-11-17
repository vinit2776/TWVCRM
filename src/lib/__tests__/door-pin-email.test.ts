import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@/lib/mailer", () => ({
  resend: { emails: { send: (...a: unknown[]) => send(...a) } },
  EMAIL_FROM: "The WorkVilla <test@example.com>",
  EMAIL_REPLY_TO: "billing@example.com",
}));
const logAudit = vi.fn();
vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { sendDoorPinEmail, doorPinEmailProblem } from "@/lib/door-pin-email";

const record = {
  admin: {} as never, contractId: "c1", memberId: "m1", performedBy: "u1", validUntil: "2027-01-31",
};

describe("sendDoorPinEmail", () => {
  beforeEach(() => { send.mockReset(); logAudit.mockReset(); });

  it("does not send, and records the attempt, when there is no email", async () => {
    const r = await sendDoorPinEmail({ to: "  ", name: "A", pin: "1234", purpose: "enrollment", record });
    expect(r).toEqual({ sent: false, reason: "no_email" });
    expect(send).not.toHaveBeenCalled();
    expect(logAudit.mock.calls[0][1].changes.door_pin.new).toMatchObject({ member_id: "m1", sent: false, reason: "no_email" });
  });

  it("emails the PIN, says it is not a login code, and records who and until when", async () => {
    send.mockResolvedValue({ data: { id: "x" }, error: null });
    const r = await sendDoorPinEmail({ to: "a@b.com", name: "A <b>", pin: "140980", purpose: "enrollment", record });
    expect(r).toEqual({ sent: true });
    const mail = send.mock.calls[0][0];
    expect(mail.to).toBe("a@b.com");
    expect(mail.html).toContain("140980");
    expect(mail.html).toContain("not a login code");
    expect(mail.html).not.toContain("<b>");
    const audit = logAudit.mock.calls[0][1];
    expect(audit.performedBy).toBe("u1");
    expect(audit.changes.door_pin.new).toMatchObject({ sent: true, email: "a@b.com", valid_until: "2027-01-31", purpose: "enrollment" });
  });

  it("reports a send failure instead of throwing", async () => {
    send.mockResolvedValue({ data: null, error: { message: "smtp down", name: "e" } });
    const r = await sendDoorPinEmail({ to: "a@b.com", name: "A", pin: "1234", purpose: "fallback" });
    expect(r).toEqual({ sent: false, reason: "send_failed" });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("tells staff the fix for a missing email", () => {
    expect(doorPinEmailProblem("no_email", "Asha")).toContain("Add their email");
  });
});
