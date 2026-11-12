import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * /api/email/inbound was unauthenticated. The request body supplies the
 * historyId that becomes the app_settings checkpoint, so an open endpoint let
 * anyone post a far-future id and silently skip every future email.
 *
 * These tests pin the property that matters most: the verifier fails CLOSED.
 * A missing or half-finished configuration must reject, never wave requests
 * through — the failure mode of "deploy first, configure later" has to be
 * "ingests nothing", not "accepts anything".
 */

const { verifyIdTokenMock } = vi.hoisted(() => ({ verifyIdTokenMock: vi.fn() }));

vi.mock("@googleapis/gmail", () => ({
  auth: {
    OAuth2: class {
      verifyIdToken = verifyIdTokenMock;
    },
  },
}));

const AUDIENCE = "https://twv-crm.vercel.app/api/email/inbound";
const SA = "gmail-push@twv.iam.gserviceaccount.com";

async function subject() {
  const mod = await import("@/lib/gmail-push-auth");
  return mod.verifyPubSubPush;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    getPayload: () => ({
      email: SA,
      email_verified: true,
      iss: "https://accounts.google.com",
      ...overrides,
    }),
  };
}

describe("verifyPubSubPush", () => {
  beforeEach(() => {
    vi.resetModules();
    verifyIdTokenMock.mockReset();
    process.env.GMAIL_PUBSUB_AUDIENCE = AUDIENCE;
    process.env.GMAIL_PUBSUB_SA_EMAIL = SA;
  });

  afterEach(() => {
    delete process.env.GMAIL_PUBSUB_AUDIENCE;
    delete process.env.GMAIL_PUBSUB_SA_EMAIL;
  });

  it("rejects when push auth is not configured", async () => {
    delete process.env.GMAIL_PUBSUB_AUDIENCE;
    delete process.env.GMAIL_PUBSUB_SA_EMAIL;
    const verify = await subject();

    expect(await verify("Bearer anything")).toEqual({
      ok: false,
      reason: "push_auth_not_configured",
    });
  });

  it("rejects when only half the configuration is present", async () => {
    delete process.env.GMAIL_PUBSUB_SA_EMAIL;
    const verify = await subject();

    const result = await verify("Bearer anything");
    expect(result.ok).toBe(false);
    // Never reaches token verification — no point trusting a partial config.
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a missing Authorization header", async () => {
    const verify = await subject();
    expect(await verify(null)).toEqual({ ok: false, reason: "missing_bearer_token" });
  });

  it("rejects a non-Bearer scheme", async () => {
    const verify = await subject();
    expect(await verify("Basic abc123")).toEqual({
      ok: false,
      reason: "missing_bearer_token",
    });
  });

  it("rejects an empty bearer token", async () => {
    const verify = await subject();
    expect(await verify("Bearer    ")).toEqual({
      ok: false,
      reason: "empty_bearer_token",
    });
  });

  it("rejects a token that fails Google's signature/audience check", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("Wrong recipient"));
    const verify = await subject();

    expect(await verify("Bearer forged")).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a valid Google token minted by a different service account", async () => {
    // verifyIdToken checks the audience but not who signed it, so without the
    // explicit email check any Google-issued token for our audience would pass.
    verifyIdTokenMock.mockResolvedValue(payload({ email: "someone-else@evil.iam.gserviceaccount.com" }));
    const verify = await subject();

    expect(await verify("Bearer valid-but-wrong-sa")).toEqual({
      ok: false,
      reason: "unexpected_service_account",
    });
  });

  it("rejects an unverified service account email", async () => {
    verifyIdTokenMock.mockResolvedValue(payload({ email_verified: false }));
    const verify = await subject();

    expect(await verify("Bearer unverified")).toEqual({
      ok: false,
      reason: "unexpected_service_account",
    });
  });

  it("rejects an unexpected issuer", async () => {
    verifyIdTokenMock.mockResolvedValue(payload({ iss: "https://evil.example.com" }));
    const verify = await subject();

    expect(await verify("Bearer wrong-issuer")).toEqual({
      ok: false,
      reason: "unexpected_issuer",
    });
  });

  it("accepts a correctly signed push from our subscription", async () => {
    verifyIdTokenMock.mockResolvedValue(payload());
    const verify = await subject();

    expect(await verify("Bearer good-token")).toEqual({ ok: true });
    expect(verifyIdTokenMock).toHaveBeenCalledWith({
      idToken: "good-token",
      audience: AUDIENCE,
    });
  });

  it("accepts the bare accounts.google.com issuer form", async () => {
    verifyIdTokenMock.mockResolvedValue(payload({ iss: "accounts.google.com" }));
    const verify = await subject();

    expect(await verify("Bearer good-token")).toEqual({ ok: true });
  });
});
