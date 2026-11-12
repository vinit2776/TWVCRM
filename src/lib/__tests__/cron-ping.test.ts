import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { envStr } from "@/lib/env";

/**
 * Regression tests for the failures that hid a four-month backup outage: env
 * vars carrying a trailing newline, and a health ping that reported success it
 * had not verified.
 */

const { upsertMock, fromMock } = vi.hoisted(() => {
  const upsertMock = vi.fn();
  const fromMock = vi.fn(() => ({ upsert: upsertMock }));
  return { upsertMock, fromMock };
});

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

const { recordCronHealth, pingCronHealth, withCronHealth } = await import("@/lib/cron-ping");

describe("envStr", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("strips the trailing newline Vercel adds to pasted values", () => {
    // The exact shape that killed the nightly DB backup:
    // getaddrinfo ENOTFOUND aws-1-ap-south-1.pooler.supabase.com\n
    process.env.TEST_HOST = "aws-1-ap-south-1.pooler.supabase.com\n";
    expect(envStr("TEST_HOST")).toBe("aws-1-ap-south-1.pooler.supabase.com");
  });

  it("strips surrounding whitespace of every kind", () => {
    process.env.TEST_URL = "  https://twv-crm.vercel.app \r\n";
    expect(envStr("TEST_URL")).toBe("https://twv-crm.vercel.app");
  });

  it("treats unset and whitespace-only as undefined so ?? fallbacks fire", () => {
    delete process.env.TEST_MISSING;
    process.env.TEST_BLANK = "   \n";
    expect(envStr("TEST_MISSING")).toBeUndefined();
    expect(envStr("TEST_BLANK")).toBeUndefined();
  });
});

describe("recordCronHealth", () => {
  beforeEach(() => {
    upsertMock.mockReset().mockResolvedValue({ error: null });
    fromMock.mockClear();
  });

  it("upserts the job row on the cron_health table", async () => {
    await recordCronHealth("cron/db-backup", "ok", { tables: 209 });

    expect(fromMock).toHaveBeenCalledWith("cron_health");
    const [row, opts] = upsertMock.mock.calls[0];
    expect(row).toMatchObject({
      job: "cron/db-backup",
      last_status: "ok",
      details: { tables: 209 },
    });
    expect(typeof row.last_run_at).toBe("string");
    // Without onConflict the second run of any job would fail the primary key.
    expect(opts).toEqual({ onConflict: "job" });
  });

  it("stores null rather than undefined when no details are given", async () => {
    await recordCronHealth("cron/db-backup");
    expect(upsertMock.mock.calls[0][0].details).toBeNull();
  });

  it("throws when the write is rejected, so callers can react", async () => {
    upsertMock.mockResolvedValue({
      error: { message: 'new row violates row-level security policy for table "cron_health"' },
    });
    await expect(recordCronHealth("cron/db-backup")).rejects.toThrow(/row-level security/);
  });
});

describe("pingCronHealth", () => {
  beforeEach(() => {
    upsertMock.mockReset().mockResolvedValue({ error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("records the run", async () => {
    await pingCronHealth("cron/db-backup", "ok");
    expect(upsertMock).toHaveBeenCalledOnce();
  });

  it("never throws when the write fails — a bad ping must not fail the job", async () => {
    upsertMock.mockRejectedValue(new Error("connection terminated"));
    await expect(pingCronHealth("cron/db-backup", "ok")).resolves.toBeUndefined();
  });

  it("logs the failure instead of swallowing it", async () => {
    // The 2026-04-22 regression: the write was denied and nothing surfaced it,
    // so the fleet looked healthy for four months.
    upsertMock.mockResolvedValue({ error: { message: "permission denied" } });

    await pingCronHealth("cron/db-backup", "ok");

    expect(console.error).toHaveBeenCalled();
    const logged = (console.error as ReturnType<typeof vi.fn>).mock.calls[0].join(" ");
    expect(logged).toContain("cron/db-backup");
  });
});

describe("withCronHealth", () => {
  beforeEach(() => {
    upsertMock.mockReset().mockResolvedValue({ error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  const recorded = () => upsertMock.mock.calls[0][0];

  it("reports ok for a 2xx handler", async () => {
    const wrapped = withCronHealth("cron/test", async () => new Response("{}", { status: 200 }));
    const res = await wrapped(new Request("http://localhost"));

    expect(res.status).toBe(200);
    expect(recorded()).toMatchObject({ job: "cron/test", last_status: "ok" });
  });

  it("reports error for a non-2xx handler", async () => {
    const wrapped = withCronHealth("cron/test", async () => new Response("boom", { status: 500 }));
    await wrapped(new Request("http://localhost"));

    expect(recorded()).toMatchObject({ job: "cron/test", last_status: "error" });
  });

  it("reports error and rethrows when the handler throws", async () => {
    const wrapped = withCronHealth("cron/test", async () => {
      throw new Error("pool connect failed");
    });

    await expect(wrapped(new Request("http://localhost"))).rejects.toThrow("pool connect failed");
    expect(recorded()).toMatchObject({ job: "cron/test", last_status: "error" });
  });

  it("does not report on 401 — an unauthorised probe is not a job run", async () => {
    // Otherwise any anonymous hit would reset the staleness clock and make a
    // dead job look healthy, which is the failure mode this monitor exists for.
    const wrapped = withCronHealth("cron/test", async () => new Response("no", { status: 401 }));
    await wrapped(new Request("http://localhost"));

    expect(upsertMock).not.toHaveBeenCalled();
  });
});
