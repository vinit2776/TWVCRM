import { describe, it, expect } from "vitest";
import {
  decideElectricityContext, invoiceKey, matchConnection,
  type ElectricityBillInput, type ElectricityContextFacts, type VendorConnection,
} from "../electricity-bill-match";

const conn = (over: Partial<VendorConnection> = {}): VendorConnection => ({
  id: "cA", location_id: "locA", location_name: "Prakash Presidium", vendor_id: "v1",
  consumer_number: "09-345-772-1180", bill_aliases: ["WORKVILLA SERVICES PVT LTD – PLOT 14"], is_active: true, ...over,
});
const connB = conn({ id: "cB", location_id: "locB", location_name: "Location B", consumer_number: "09-221-554-0032", bill_aliases: ["WV OPERATIONS – 2ND FLOOR"] });

const input = (over: Partial<ElectricityBillInput> = {}): ElectricityBillInput => ({
  location_id: "locA", connection_id: null, consumer_number: null, printed_name: null, acknowledge_mismatch: false, remember_name: false, ...over,
});
const facts = (over: Partial<ElectricityContextFacts> = {}): ElectricityContextFacts => ({
  vendorIsElectricityProvider: true, hasPo: false, billCompanyId: "co1",
  location: { id: "locA", name: "Prakash Presidium", company_id: "co1", is_active: true },
  connections: [conn(), connB], ...over,
});

describe("invoiceKey", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(invoiceKey("EB/09/2026/00418")).toBe("eb0920260041" + "8");
    expect(invoiceKey("eb-09-2026-00418")).toBe(invoiceKey("EB/09/2026/00418"));
    expect(invoiceKey(" eb 09 2026 00418 ")).toBe(invoiceKey("EB/09/2026/00418"));
  });
  it("is null when empty", () => {
    expect(invoiceKey("")).toBeNull();
    expect(invoiceKey(" / ")).toBeNull();
    expect(invoiceKey(null)).toBeNull();
  });
});

describe("matchConnection", () => {
  const cs = [conn(), connB];
  it("matches by consumer number however it is punctuated", () => {
    const m = matchConnection(cs, { consumer_number: "093457721180", printed_name: null });
    expect(m).toMatchObject({ status: "match", via: ["consumer_number"] });
    expect(m.status === "match" && m.connection.id).toBe("cA");
  });
  it("matches by remembered name ignoring case and punctuation", () => {
    const m = matchConnection(cs, { consumer_number: null, printed_name: "workvilla services pvt. ltd - plot 14" });
    expect(m).toMatchObject({ status: "match", via: ["name"] });
  });
  it("reports both when number and name agree", () => {
    const m = matchConnection(cs, { consumer_number: "09-345-772-1180", printed_name: "WORKVILLA SERVICES PVT LTD – PLOT 14" });
    expect(m).toMatchObject({ status: "match", via: ["consumer_number", "name"] });
  });
  it("is a conflict when the number and the name point at different connections", () => {
    const m = matchConnection(cs, { consumer_number: "09-221-554-0032", printed_name: "WORKVILLA SERVICES PVT LTD – PLOT 14" });
    expect(m.status).toBe("conflict");
  });
  it("never applies a near match", () => {
    expect(matchConnection(cs, { consumer_number: "09-345-772-118", printed_name: "Workvilla Plot 14" }).status).toBe("none");
  });
  it("ignores deactivated connections", () => {
    expect(matchConnection([conn({ is_active: false })], { consumer_number: "09-345-772-1180", printed_name: null }).status).toBe("none");
  });
  it("is none when the bill prints nothing", () => {
    expect(matchConnection(cs, { consumer_number: "", printed_name: "  " }).status).toBe("none");
  });
});

describe("decideElectricityContext — who it applies to", () => {
  it("does nothing for a vendor that is not an electricity provider", () => {
    expect(decideElectricityContext(input({ location_id: null }), facts({ vendorIsElectricityProvider: false }))).toEqual({ ok: true, extra: null, rememberName: null });
  });
  it("does nothing for a PO-linked bill", () => {
    expect(decideElectricityContext(input({ location_id: null }), facts({ hasPo: true }))).toEqual({ ok: true, extra: null, rememberName: null });
  });
});

describe("decideElectricityContext — the location is required and must fit", () => {
  const code = (d: ReturnType<typeof decideElectricityContext>) => (d.ok ? null : d.code);
  it("requires a location", () => {
    expect(code(decideElectricityContext(input({ location_id: null }), facts()))).toBe("location_required");
  });
  it("rejects an unknown or inactive location", () => {
    expect(code(decideElectricityContext(input(), facts({ location: null })))).toBe("location_not_found");
    expect(code(decideElectricityContext(input(), facts({ location: { id: "locA", name: "X", company_id: "co1", is_active: false } })))).toBe("location_inactive");
  });
  it("rejects a location from a different company than the bill", () => {
    expect(code(decideElectricityContext(input(), facts({ billCompanyId: "co2" })))).toBe("company_mismatch");
  });
  it("accepts a location with no company recorded rather than blocking on missing data", () => {
    const d = decideElectricityContext(input(), facts({ location: { id: "locA", name: "X", company_id: null, is_active: true } }));
    expect(d.ok).toBe(true);
  });
});

describe("decideElectricityContext — the connection", () => {
  it("fills the connection from the consumer number when it is at the chosen location", () => {
    const d = decideElectricityContext(input({ consumer_number: "09-345-772-1180" }), facts());
    expect(d).toMatchObject({ ok: true, extra: { location_id: "locA", connection_id: "cA", electricity_consumer_number: "09-345-772-1180" } });
  });
  it("fills it from a remembered name", () => {
    const d = decideElectricityContext(input({ printed_name: "workvilla services pvt ltd - plot 14" }), facts());
    expect(d).toMatchObject({ ok: true, extra: { connection_id: "cA" } });
  });
  it("uses the only connection at the location when nothing printed matches", () => {
    const d = decideElectricityContext(input({ consumer_number: "99-000" }), facts());
    expect(d).toMatchObject({ ok: true, extra: { connection_id: "cA" } });
  });
  it("leaves the connection empty when the location has several and nothing identifies one", () => {
    const two = [conn(), conn({ id: "cA2", consumer_number: "09-999-111-0001", bill_aliases: [] })];
    const d = decideElectricityContext(input(), facts({ connections: two }));
    expect(d).toMatchObject({ ok: true, extra: { connection_id: null } });
  });
  it("leaves it empty when the location has none", () => {
    const d = decideElectricityContext(input({ location_id: "locA" }), facts({ connections: [connB] }));
    expect(d).toMatchObject({ ok: true, extra: { connection_id: null } });
  });
  it("accepts an explicitly chosen connection at the location", () => {
    const d = decideElectricityContext(input({ connection_id: "cA" }), facts());
    expect(d).toMatchObject({ ok: true, extra: { connection_id: "cA" } });
  });
  it("rejects a chosen connection that belongs to another location", () => {
    const d = decideElectricityContext(input({ connection_id: "cB" }), facts());
    expect(d).toMatchObject({ ok: false, code: "connection_location_mismatch" });
  });
  it("rejects an unknown or deactivated connection", () => {
    expect(decideElectricityContext(input({ connection_id: "nope" }), facts())).toMatchObject({ ok: false, code: "connection_not_found" });
    expect(decideElectricityContext(input({ connection_id: "cA" }), facts({ connections: [conn({ is_active: false })] }))).toMatchObject({ ok: false, code: "connection_not_found" });
  });
});

describe("decideElectricityContext — when the bill points somewhere else", () => {
  it("stops when the consumer number belongs to another location, until confirmed", () => {
    const d = decideElectricityContext(input({ consumer_number: "09-221-554-0032" }), facts());
    expect(d).toMatchObject({ ok: false, status: 409, code: "location_mismatch" });
    expect(d.ok === false && d.error).toMatch(/Location B/);
    expect(d.ok === false && d.error).toMatch(/Prakash Presidium/);
  });
  it("saves once the person confirms, and stores the chosen location — not the matched one", () => {
    const d = decideElectricityContext(input({ consumer_number: "09-221-554-0032", acknowledge_mismatch: true }), facts());
    expect(d).toMatchObject({ ok: true, extra: { location_id: "locA" } });
  });
  it("a confirmed mismatch does not attach the other location's connection", () => {
    const d = decideElectricityContext(input({ consumer_number: "09-221-554-0032", acknowledge_mismatch: true }), facts());
    expect(d.ok && d.extra?.connection_id).not.toBe("cB");
  });
  it("stops when the number and the name point at different connections", () => {
    const d = decideElectricityContext(input({ consumer_number: "09-221-554-0032", printed_name: "WORKVILLA SERVICES PVT LTD – PLOT 14" }), facts());
    expect(d).toMatchObject({ ok: false, code: "identifier_conflict" });
  });
  it("stops when a different connection at the same location is chosen than the bill identifies", () => {
    const two = [conn(), conn({ id: "cA2", consumer_number: "09-999-111-0001", bill_aliases: [] }), connB];
    const d = decideElectricityContext(input({ connection_id: "cA2", consumer_number: "09-345-772-1180" }), facts({ connections: two }));
    expect(d).toMatchObject({ ok: false, code: "connection_mismatch" });
  });
});

describe("decideElectricityContext — remembering a wording", () => {
  it("offers a new wording for the connection the bill belongs to", () => {
    const d = decideElectricityContext(input({ consumer_number: "09-345-772-1180", printed_name: "WV Prakash – Blk A", remember_name: true }), facts());
    expect(d).toMatchObject({ ok: true, rememberName: { connection_id: "cA", name: "WV Prakash – Blk A" } });
  });
  it("does not re-teach a wording the connection already knows", () => {
    const d = decideElectricityContext(input({ consumer_number: "09-345-772-1180", printed_name: "workvilla services pvt ltd – plot 14", remember_name: true }), facts());
    expect(d).toMatchObject({ ok: true, rememberName: null });
  });
  it("does nothing unless asked", () => {
    const d = decideElectricityContext(input({ consumer_number: "09-345-772-1180", printed_name: "New wording" }), facts());
    expect(d).toMatchObject({ ok: true, rememberName: null });
  });
  it("has nowhere to put it when no connection was identified", () => {
    const two = [conn(), conn({ id: "cA2", consumer_number: "09-999-111-0001", bill_aliases: [] })];
    const d = decideElectricityContext(input({ printed_name: "New wording", remember_name: true }), facts({ connections: two }));
    expect(d).toMatchObject({ ok: true, rememberName: null });
  });
  it("never learns a wording from a conflicting bill, even when confirmed", () => {
    const d = decideElectricityContext(
      input({ consumer_number: "09-221-554-0032", printed_name: "WORKVILLA SERVICES PVT LTD – PLOT 14", remember_name: true, acknowledge_mismatch: true }),
      facts()
    );
    expect(d).toMatchObject({ ok: true, rememberName: null });
  });
});
