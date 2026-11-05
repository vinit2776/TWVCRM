import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Everything the route touches is mocked: no database, no email, no network.
const send = vi.fn();
const loadFacts = vi.fn();
const getSettings = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/mailer", () => ({ resend: { emails: { send: (...a: unknown[]) => send(...a) } }, EMAIL_FROM: "test@example.com" }));
vi.mock("@/lib/cron-ping", () => ({ withCronHealth: (_job: string, h: unknown) => h }));
vi.mock("@/lib/app-settings-cache", () => ({ getCachedSettings: (...a: unknown[]) => getSettings(...a) }));
vi.mock("@/lib/auto-renewal-plan-server", () => ({ loadAutoRenewFacts: (...a: unknown[]) => loadFacts(...a) }));

import { GET } from "@/app/api/cron/auto-renew/route";
import type { AutoRenewFacts } from "@/lib/auto-renewal-plan";

const handler = GET as unknown as (req: Request) => Promise<Response>;
const call = (auth: string | null = "Bearer s3cret") =>
  handler(new Request("https://example.test/api/cron/auto-renew", { headers: auth ? { Authorization: auth } : {} }));

const oneContract: AutoRenewFacts = {
  id: "c-1", contractNumber: "TWV-C-0100", customer: "Acme", location: null, status: "active",
  endDate: "2099-11-30", noticePeriodMonths: 2, seats: 1,
  items: [{ description: "Rent", quantity: 1, unit_price: 10000, escalates: true }], subtotal: 10000,
  agreementEscalationPercentage: 10, escalationPercentage: 10, renewalDeclined: false, hasLiveExit: false,
  overdueAmount: 0, hasActiveMoratorium: false, hasActiveRentWaiver: false, hasRatePhases: false,
  specialClauseStatus: null, escalationApprovalPending: false, renewalDraft: null,
};

describe("GET /api/cron/auto-renew", () => {
  beforeEach(() => {
    send.mockReset();
    loadFacts.mockReset();
    getSettings.mockReset();
    getSettings.mockResolvedValue({ auto_renew_cron_mode: "dry_run" });
    process.env.CRON_SECRET = "s3cret";
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("rejects a request without the cron secret, and when no secret is configured", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call("Bearer undefined")).status).toBe(401);
    expect(loadFacts).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing when the mode is off", async () => {
    getSettings.mockResolvedValue({ auto_renew_cron_mode: "off" });
    const body = await (await call()).json();
    expect(body.skipped).toMatch(/off/);
    expect(loadFacts).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("says so, and sends nothing, when the columns are not on the database yet", async () => {
    loadFacts.mockResolvedValue(null);
    const body = await (await call()).json();
    expect(body.skipped).toMatch(/not on this database/);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends no email when no contract is opted in", async () => {
    loadFacts.mockResolvedValue([]);
    const body = await (await call()).json();
    expect(body).toMatchObject({ optedIn: 0, emailed: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("emails one internal digest, marked as a dry run, to admin and accounts only", async () => {
    loadFacts.mockResolvedValue([oneContract]);
    const body = await (await call()).json();
    expect(body).toMatchObject({ mode: "dry_run", optedIn: 1, emailed: true });
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(["admin@theworkvilla.com", "accounts@theworkvilla.com"]);
    expect(mail.subject).toMatch(/^\[Dry run\]/);
    expect(mail.html).toContain("no customer was contacted");
  });

  it("treats live as a dry run, because live is not built", async () => {
    getSettings.mockResolvedValue({ auto_renew_cron_mode: "live" });
    loadFacts.mockResolvedValue([oneContract]);
    const body = await (await call()).json();
    expect(body).toMatchObject({ mode: "dry_run", liveRequestedButNotBuilt: true });
    expect(send.mock.calls[0][0].subject).toMatch(/^\[Dry run\]/);
  });

  it("treats a junk mode as a dry run", async () => {
    getSettings.mockResolvedValue({ auto_renew_cron_mode: "yes please" });
    loadFacts.mockResolvedValue([oneContract]);
    expect((await (await call()).json()).mode).toBe("dry_run");
  });

  it("still reports success when the email provider fails", async () => {
    loadFacts.mockResolvedValue([oneContract]);
    send.mockRejectedValue(new Error("provider down"));
    const body = await (await call()).json();
    expect(body).toMatchObject({ success: true, emailed: false });
  });

  it("ignores the query string: nothing in the URL can change the mode", async () => {
    getSettings.mockResolvedValue({ auto_renew_cron_mode: "off" });
    const res = await handler(
      new Request("https://example.test/api/cron/auto-renew?mode=live&dry_run=0", { headers: { Authorization: "Bearer s3cret" } }),
    );
    expect((await res.json()).skipped).toMatch(/off/);
    expect(send).not.toHaveBeenCalled();
  });
});
