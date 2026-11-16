import { describe, it, expect } from "vitest";
import {
  deriveLifecycleState,
  decidePaidQuery,
  lastSpeaker,
  PAID_QUERY_GRACE_DAYS,
  type LifecycleMessage,
} from "@/lib/queries/lifecycle";

const ASKER = "asker";
const OTHER = "other";
const msg = (event_type: string, created_by: string, created_at: string): LifecycleMessage => ({
  event_type,
  created_by,
  created_at,
});

describe("deriveLifecycleState", () => {
  it("is open while only the asker has spoken", () => {
    const r = deriveLifecycleState({ status: "open", created_by_id: ASKER, messages: [msg("message", ASKER, "2026-11-01T00:00:00Z")] });
    expect(r.state).toBe("open");
  });
  it("is answered once someone else replies", () => {
    const r = deriveLifecycleState({
      status: "open",
      created_by_id: ASKER,
      messages: [msg("message", ASKER, "2026-11-01T00:00:00Z"), msg("message", OTHER, "2026-11-02T00:00:00Z")],
    });
    expect(r).toEqual({ state: "answered", answeredById: OTHER });
  });
  it("goes back to open when the asker follows up", () => {
    const r = deriveLifecycleState({
      status: "open",
      created_by_id: ASKER,
      messages: [msg("message", ASKER, "2026-11-01T00:00:00Z"), msg("message", OTHER, "2026-11-02T00:00:00Z"), msg("message", ASKER, "2026-11-03T00:00:00Z")],
    });
    expect(r.state).toBe("open");
  });
  it("ignores automatic events stamped with the asker as author", () => {
    const messages = [msg("message", ASKER, "2026-11-01T00:00:00Z"), msg("message", OTHER, "2026-11-02T00:00:00Z"), msg("paid_nudge", ASKER, "2026-11-03T00:00:00Z")];
    expect(lastSpeaker(messages)?.created_by).toBe(OTHER);
    expect(deriveLifecycleState({ status: "open", created_by_id: ASKER, messages }).state).toBe("answered");
  });
  it("is closed when resolved", () => {
    expect(deriveLifecycleState({ status: "resolved", created_by_id: ASKER, messages: [] }).state).toBe("closed");
  });
});

describe("decidePaidQuery", () => {
  const paidAt = "2026-11-05T00:00:00Z";
  const base = {
    status: "open" as const,
    billPaidAt: paidAt,
    billCorrected: true,
    paidNudgedAt: null,
    messages: [msg("message", ASKER, "2026-11-01T00:00:00Z"), msg("message", OTHER, "2026-11-02T00:00:00Z")],
    now: new Date("2026-11-06T00:00:00Z"),
  };

  it("does nothing while the bill is unpaid or the query is closed", () => {
    expect(decidePaidQuery({ ...base, billPaidAt: null })).toBe("none");
    expect(decidePaidQuery({ ...base, status: "resolved" })).toBe("none");
  });
  it("nudges first, never closes on payment itself", () => {
    expect(decidePaidQuery(base)).toBe("nudge");
  });
  it("waits out the grace period after the nudge", () => {
    expect(decidePaidQuery({ ...base, paidNudgedAt: "2026-11-05T12:00:00Z", now: new Date("2026-11-07T00:00:00Z") })).toBe("none");
  });
  it("auto-closes once the grace period has passed with no reply", () => {
    const nudged = "2026-11-06T00:00:00Z";
    const now = new Date(new Date(nudged).getTime() + PAID_QUERY_GRACE_DAYS * 86_400_000);
    expect(decidePaidQuery({ ...base, paidNudgedAt: nudged, now })).toBe("auto_close");
  });
  it("does not auto-close if anyone replied after the payment", () => {
    const nudged = "2026-11-06T00:00:00Z";
    const now = new Date("2026-11-20T00:00:00Z");
    const messages = [...base.messages, msg("message", ASKER, "2026-11-07T00:00:00Z")];
    expect(decidePaidQuery({ ...base, messages, paidNudgedAt: nudged, now })).toBe("flag_only");
  });
  it("never auto-closes a query not tied to a bill correction (documents / vendor details)", () => {
    expect(decidePaidQuery({ ...base, billCorrected: false })).toBe("flag_only");
    expect(decidePaidQuery({ ...base, billCorrected: false, paidNudgedAt: "2026-10-01T00:00:00Z" })).toBe("flag_only");
  });
  it("never re-closes a query a person reopened", () => {
    const messages = [...base.messages, msg("reopened", ASKER, "2026-11-07T00:00:00Z")];
    expect(decidePaidQuery({ ...base, messages, paidNudgedAt: "2026-10-01T00:00:00Z", now: new Date("2026-12-01T00:00:00Z") })).toBe("flag_only");
  });
});
