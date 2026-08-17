import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression tests for the email daily counter.
 *
 * On 2026-04-13 tracking became `void client.rpc(...)`. supabase-js query
 * builders are lazy thenables — the HTTP request is only issued when .then()
 * is called — so the builder was discarded without ever executing. The counter
 * silently stopped, last recording 2026-04-12, and every email since went
 * unrecorded.
 *
 * The mock below reproduces that laziness deliberately: calling rpc() records
 * an *invocation*, but the request only counts as *executed* when something
 * awaits the returned thenable. Asserting on invocation alone would pass
 * against the broken code, which is exactly how this class of bug survives a
 * test suite.
 */

const h = vi.hoisted(() => ({
  rpcInvoked: vi.fn(),
  rpcExecuted: vi.fn(),
  sendMailMock: vi.fn(),
  resendSendMock: vi.fn(),
  rpcResult: { error: null } as { error: { message: string } | null },
  rpcThrows: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    rpc: (...args: unknown[]) => {
      h.rpcInvoked(...args);
      // Faithful to PostgrestBuilder: nothing leaves the process until then().
      return {
        then(onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) {
          h.rpcExecuted(...args);
          const p = h.rpcThrows
            ? Promise.reject(new Error("db unreachable"))
            : Promise.resolve(h.rpcResult);
          return p.then(onOk, onErr);
        },
      };
    },
  }),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: h.sendMailMock }) },
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: h.resendSendMock };
  },
}));

// mailer.ts reads SMTP creds at module scope, so they must exist before import.
process.env.SMTP_USER = "contact@theworkvilla.com";
process.env.SMTP_PASS = "app-password";
process.env.RESEND_API_KEY = "re_test";

const { resend } = await import("@/lib/mailer");

const PARAMS = {
  from: "The WorkVilla <contact@theworkvilla.com>",
  to: "someone@example.com",
  subject: "s",
  html: "<p>h</p>",
};

describe("email counter", () => {
  beforeEach(() => {
    h.rpcInvoked.mockReset();
    h.rpcExecuted.mockReset();
    h.sendMailMock.mockReset();
    h.resendSendMock.mockReset();
    h.rpcResult = { error: null };
    h.rpcThrows = false;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  const executed = () => h.rpcExecuted.mock.calls[0];

  it("actually executes the RPC rather than discarding a lazy builder", async () => {
    h.sendMailMock.mockResolvedValue({ messageId: "smtp-1" });

    await resend.emails.send(PARAMS);

    // `void builder` would satisfy rpcInvoked but never rpcExecuted.
    expect(h.rpcInvoked).toHaveBeenCalledOnce();
    expect(h.rpcExecuted).toHaveBeenCalledOnce();
    expect(executed()[0]).toBe("increment_email_count");
  });

  it("counts a successful SMTP send as sent", async () => {
    h.sendMailMock.mockResolvedValue({ messageId: "smtp-1" });

    await resend.emails.send(PARAMS);

    expect(executed()[1]).toMatchObject({ p_success: true });
    expect((executed()[1] as { p_date: string }).p_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("counts an email rescued by the Resend fallback as SENT, not failed", async () => {
    // Previously the SMTP failure was recorded as a failed email and the
    // successful fallback recorded nothing, so a delivered message landed in
    // the failure column and made the fallback look like the problem.
    h.sendMailMock.mockRejectedValue(new Error("SMTP down"));
    h.resendSendMock.mockResolvedValue({ data: { id: "resend-1" }, error: null });

    await resend.emails.send(PARAMS);

    expect(h.rpcExecuted).toHaveBeenCalledOnce();
    expect(executed()[1]).toMatchObject({ p_success: true });
  });

  it("counts a failure when both transports fail", async () => {
    h.sendMailMock.mockRejectedValue(new Error("SMTP down"));
    h.resendSendMock.mockResolvedValue({
      data: null,
      error: { message: "domain is not verified", name: "validation_error" },
    });

    await resend.emails.send(PARAMS);

    expect(executed()[1]).toMatchObject({ p_success: false });
  });

  it("records exactly one row per email, not one per transport attempt", async () => {
    h.sendMailMock.mockRejectedValue(new Error("SMTP down"));
    h.resendSendMock.mockResolvedValue({ data: { id: "resend-1" }, error: null });

    await resend.emails.send(PARAMS);

    expect(h.rpcExecuted).toHaveBeenCalledTimes(1);
  });

  it("never fails the send when the counter write errors", async () => {
    h.sendMailMock.mockResolvedValue({ messageId: "smtp-1" });
    h.rpcThrows = true;

    const result = await resend.emails.send(PARAMS);

    expect(result.error).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});
