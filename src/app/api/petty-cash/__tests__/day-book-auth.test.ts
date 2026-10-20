import { describe, it, expect, vi, beforeEach } from "vitest";

// Every collaborator is mocked so a request that gets past the auth gate by mistake
// cannot query the database or send mail — it just trips the assertions below.
const createAdminClient = vi.fn();
const send = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => createAdminClient() }));
vi.mock("@/lib/mailer", () => ({
  resend: { emails: { send: (...a: unknown[]) => send(...a) } },
  EMAIL_FROM: "from@example.com",
  EMAIL_REPLY_TO: "reply@example.com",
}));
vi.mock("@/lib/cron-ping", () => ({ pingCronHealth: vi.fn() }));

import { GET } from "../day-book/route";

describe("GET /api/petty-cash/day-book auth", () => {
  beforeEach(() => {
    createAdminClient.mockReset();
    send.mockReset();
    process.env.CRON_SECRET = "test-secret";
  });

  it("rejects a request with no authorization header", async () => {
    const res = await GET(new Request("http://localhost/api/petty-cash/day-book"));
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret, including when a date is supplied", async () => {
    const res = await GET(
      new Request("http://localhost/api/petty-cash/day-book?date=2026-10-01", {
        headers: { authorization: "Bearer nope" },
      })
    );
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("lets the correct secret through to the data query", async () => {
    // Throwing here proves the gate opened without needing a full query mock.
    createAdminClient.mockImplementation(() => {
      throw new Error("reached-db");
    });
    await expect(
      GET(
        new Request("http://localhost/api/petty-cash/day-book", {
          headers: { authorization: "Bearer test-secret" },
        })
      )
    ).rejects.toThrow("reached-db");
    expect(send).not.toHaveBeenCalled();
  });
});
