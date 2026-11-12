import { describe, it, expect, vi, beforeEach } from "vitest";

// Two transporters are created at import (normal + patient); both share the same
// sendMail mock so the retry/fallback logic can be driven from one place.
const sendMail = vi.fn();
const resendSend = vi.fn();

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({ rpc: vi.fn() }),
}));

const params = { from: "a@x.com", to: "b@y.com", subject: "s", html: "<p>h</p>" };

async function loadMailer() {
  vi.resetModules();
  vi.stubEnv("SMTP_USER", "contact@theworkvilla.com");
  vi.stubEnv("SMTP_PASS", "pw");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  return import("@/lib/mailer");
}

describe("mailer SMTP resilience", () => {
  beforeEach(() => {
    sendMail.mockReset();
    resendSend.mockReset();
    vi.useFakeTimers();
  });

  it("flags only the 4xx 'try again later' codes as transient", async () => {
    const { isTransientSmtpError } = await loadMailer();
    expect(isTransientSmtpError({ responseCode: 421 })).toBe(true);
    expect(isTransientSmtpError({ responseCode: 451 })).toBe(true);
    expect(isTransientSmtpError({ responseCode: 550 })).toBe(false);
    expect(isTransientSmtpError(new Error("Timeout"))).toBe(false);
    expect(isTransientSmtpError(null)).toBe(false);
  });

  it("retries once on a Google 421 and succeeds without touching Resend", async () => {
    const { resend } = await loadMailer();
    sendMail
      .mockRejectedValueOnce(Object.assign(new Error("421 4.3.0 Temporary System Problem"), { responseCode: 421 }))
      .mockResolvedValueOnce({ messageId: "m1" });
    const p = resend.emails.send(params);
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await p;
    expect(result.error).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("does not retry a permanent SMTP rejection", async () => {
    const { resend } = await loadMailer();
    sendMail.mockRejectedValue(Object.assign(new Error("550 rejected"), { responseCode: 550 }));
    resendSend.mockResolvedValue({ data: { id: "r1" }, error: null });
    const result = await resend.emails.send(params);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(result.error).toBeNull(); // delivered by the Resend fallback
  });

  it("keeps the SMTP failure in the error when the Resend fallback also fails", async () => {
    const { resend } = await loadMailer();
    sendMail.mockRejectedValue(new Error("Timeout"));
    resendSend.mockResolvedValue({ data: null, error: { message: "The theworkvilla.com domain is not verified." } });
    const result = await resend.emails.send(params);
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain("SMTP: Timeout");
    expect(result.error?.message).toContain("domain is not verified");
  });
});
