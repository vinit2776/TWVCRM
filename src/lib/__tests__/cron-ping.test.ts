import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { envStr } from "@/lib/env";
import { pingCronHealth, withCronHealth } from "@/lib/cron-ping";

/**
 * Regression tests for the two silent failures that hid a four-month backup
 * outage: env vars carrying a trailing newline, and a health ping that
 * swallowed rejections.
 */

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

describe("pingCronHealth", () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://twv-crm.vercel.app";
    process.env.CRON_SECRET = "test-secret";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.restoreAllMocks();
  });

  it("builds a clean URL even when the base URL has a trailing newline", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://twv-crm.vercel.app\n";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await pingCronHealth("cron/db-backup", "ok");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://twv-crm.vercel.app/api/health/cron-ping"
    );
  });

  it("logs when the ping is rejected instead of swallowing it", async () => {
    // This is the exact failure that ran unnoticed from 2026-04-22: RLS denied
    // the upsert, the route returned 500, and nothing surfaced it.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'new row violates row-level security policy for table "cron_health"',
    });
    vi.stubGlobal("fetch", fetchMock);

    await pingCronHealth("cron/db-backup", "ok");

    expect(console.error).toHaveBeenCalled();
    const logged = (console.error as ReturnType<typeof vi.fn>).mock.calls[0].join(" ");
    expect(logged).toContain("cron/db-backup");
    expect(logged).toContain("500");
  });

  it("never throws when the ping itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(pingCronHealth("cron/db-backup", "ok")).resolves.toBeUndefined();
  });

  it("skips and warns when CRON_SECRET is absent", async () => {
    delete process.env.CRON_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await pingCronHealth("cron/db-backup", "ok");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("withCronHealth", () => {
  const ORIGINAL = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://twv-crm.vercel.app";
    process.env.CRON_SECRET = "test-secret";
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.restoreAllMocks();
  });

  const pingBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it("reports ok for a 2xx handler", async () => {
    const wrapped = withCronHealth("cron/test", async () => new Response("{}", { status: 200 }));
    const res = await wrapped(new Request("http://localhost"));

    expect(res.status).toBe(200);
    expect(pingBody()).toMatchObject({ job: "cron/test", status: "ok" });
  });

  it("reports error for a non-2xx handler", async () => {
    const wrapped = withCronHealth("cron/test", async () => new Response("boom", { status: 500 }));
    await wrapped(new Request("http://localhost"));

    expect(pingBody()).toMatchObject({ job: "cron/test", status: "error" });
  });

  it("reports error and rethrows when the handler throws", async () => {
    const wrapped = withCronHealth("cron/test", async () => {
      throw new Error("pool connect failed");
    });

    await expect(wrapped(new Request("http://localhost"))).rejects.toThrow("pool connect failed");
    expect(pingBody()).toMatchObject({ job: "cron/test", status: "error" });
  });

  it("does not report on 401 — an unauthorised probe is not a job run", async () => {
    // Otherwise any anonymous hit would reset the staleness clock and make a
    // dead job look healthy, which is the failure mode this monitor exists for.
    const wrapped = withCronHealth("cron/test", async () => new Response("no", { status: 401 }));
    await wrapped(new Request("http://localhost"));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
