import { describe, expect, it } from "vitest";
import { deviceDisplayName, resolveDevices, type GuestRecord } from "@/lib/customer-value/wifi-devices";

const C1 = { id: "c1", contract_number: "TWV-C-0010" };
const C2 = { id: "c2", contract_number: "TWV-C-0011" };
const guest = (mac: string, name: string, extra: Partial<GuestRecord> = {}): GuestRecord => ({ mac, name, ...extra });
const none = { issuances: [], adhocLinks: [], labels: [] };

describe("resolveDevices", () => {
  it("matches a seat voucher that has a live issuance for the customer's own contract", () => {
    const d = resolveDevices({
      contracts: [C1], guests: [guest("AA:00:00:00:00:01", "TWV-C-0010_seat2", { hostname: "laptop", end: 1_760_000_000 })],
      issuances: [{ contract_id: "c1", seat_number: 2, revoked_at: null, member_name: "Asha" }], adhocLinks: [], labels: [],
    });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ mac: "aa:00:00:00:00:01", how: ["seat"], seat: 2, memberName: "Asha", hostname: "laptop", contractNumber: "TWV-C-0010" });
    expect(d[0].lastSeen).toBe(new Date(1_760_000_000_000).toISOString());
  });

  it("ignores a seat note with no issuance, a revoked one, and another customer's contract", () => {
    const guests = [guest("aa:00:00:00:00:01", "TWV-C-0010_seat1"), guest("aa:00:00:00:00:02", "TWV-C-0010_seat2"), guest("aa:00:00:00:00:03", "TWV-C-0011_seat1")];
    const d = resolveDevices({
      contracts: [C1], guests,
      issuances: [
        { contract_id: "c1", seat_number: 2, revoked_at: "2026-01-01", member_name: null },
        { contract_id: "c2", seat_number: 1, revoked_at: null, member_name: null },
      ], adhocLinks: [], labels: [],
    });
    expect(d).toEqual([]);
  });

  it("matches an ad-hoc voucher only when staff linked it to this customer", () => {
    const guests = [guest("aa:00:00:00:00:01", "guest of Raj"), guest("aa:00:00:00:00:02", "someone else")];
    const d = resolveDevices({ contracts: [C1], guests, ...none, adhocLinks: [{ note: "guest of Raj", contract_id: "c1" }, { note: "someone else", contract_id: "c2" }] });
    expect(d.map((x) => x.mac)).toEqual(["aa:00:00:00:00:01"]);
    expect(d[0].how).toEqual(["adhoc"]);
  });

  it("counts a label linked to his contract even if the console no longer lists the guest", () => {
    const d = resolveDevices({ contracts: [C1], guests: [], ...none, labels: [{ mac: "AA:00:00:00:00:09", label: "Front desk phone", contract_id: "c1" }, { mac: "aa:00:00:00:00:08", label: "Unlinked", contract_id: null }] });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ mac: "aa:00:00:00:00:09", label: "Front desk phone", how: ["label"] });
  });

  it("merges a device matched two ways into one row", () => {
    const d = resolveDevices({
      contracts: [C1], guests: [guest("aa:00:00:00:00:01", "TWV-C-0010_seat1")],
      issuances: [{ contract_id: "c1", seat_number: 1, revoked_at: null, member_name: null }], adhocLinks: [],
      labels: [{ mac: "aa:00:00:00:00:01", label: "Asha's laptop", contract_id: "c1" }],
    });
    expect(d).toHaveLength(1);
    expect(d[0].how.sort()).toEqual(["label", "seat"]);
    expect(d[0].label).toBe("Asha's laptop");
  });
});

describe("deviceDisplayName", () => {
  const base = { label: null, memberName: null, hostname: null, mac: "aa:00:00:00:ab:cd" };
  it("prefers a given name, then the member, then the hostname, never blank", () => {
    expect(deviceDisplayName({ ...base, label: "L", memberName: "M", hostname: "H" })).toBe("L");
    expect(deviceDisplayName({ ...base, memberName: "M", hostname: "H" })).toBe("M");
    expect(deviceDisplayName({ ...base, hostname: "H" })).toBe("H");
    expect(deviceDisplayName(base)).toBe("Device ab:cd");
  });
});
