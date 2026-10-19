/**
 * Customer Value — which Wi-Fi devices belong to a customer
 * (docs/customer-value-tab-spec.md, section 5.7).
 *
 * Only links that were made on purpose count, the same "confirmed" tier the
 * Network > Vouchers page uses:
 *  - a contract seat voucher whose note is "{contract number}_seat{N}" and has a
 *    live issuance row for that contract and seat;
 *  - an ad-hoc voucher that staff linked to one of the customer's contracts;
 *  - a device label that staff linked to one of the customer's contracts.
 * Fuzzy name or cabin matches are never counted here: they are guesses, and these
 * figures feed scores and cost.
 *
 * Pure: the route loads the records.
 */

export interface GuestRecord {
  mac: string;
  name?: string;
  code?: string;
  hostname?: string;
  start?: number;
  end?: number;
}

export interface ContractRef {
  id: string;
  contract_number: string;
}

export interface IssuanceRow {
  contract_id: string;
  seat_number: number;
  revoked_at: string | null;
  member_name: string | null;
}

export interface AdhocLink {
  note: string;
  contract_id: string;
}

export interface LabelRow {
  mac: string;
  label: string;
  contract_id: string | null;
}

export type DeviceHow = "seat" | "adhoc" | "label";

export interface WifiDevice {
  /** Lower-case, colon separated. */
  mac: string;
  /** The name a person gave it, when they did. */
  label: string | null;
  /** The seat holder's name, when the voucher was issued to a named member. */
  memberName: string | null;
  hostname: string | null;
  how: DeviceHow[];
  seat: number | null;
  contractId: string;
  contractNumber: string;
  /** ISO time of the newest session the console holds for this device. */
  lastSeen: string | null;
}

const SEAT_NOTE = /^(.+)_seat(\d+)$/;

/** What to call a device: a given name, then the member's, then the device's own, never blank. */
export function deviceDisplayName(d: Pick<WifiDevice, "label" | "memberName" | "hostname" | "mac">): string {
  return d.label ?? d.memberName ?? d.hostname ?? `Device ${d.mac.slice(-5)}`;
}

function seenAt(g: GuestRecord): number {
  return (g.end ?? g.start ?? 0) * 1000;
}

export function resolveDevices(args: {
  contracts: ContractRef[];
  guests: GuestRecord[];
  issuances: IssuanceRow[];
  adhocLinks: AdhocLink[];
  labels: LabelRow[];
}): WifiDevice[] {
  const byNumber = new Map(args.contracts.map((c) => [c.contract_number, c]));
  const byId = new Map(args.contracts.map((c) => [c.id, c]));
  const liveIssuance = new Map<string, IssuanceRow>();
  for (const i of args.issuances) {
    if (!i.revoked_at && byId.has(i.contract_id)) liveIssuance.set(`${i.contract_id}:${i.seat_number}`, i);
  }
  const adhocContractByNote = new Map<string, string>();
  for (const l of args.adhocLinks) {
    if (byId.has(l.contract_id) && !adhocContractByNote.has(l.note)) adhocContractByNote.set(l.note, l.contract_id);
  }
  const labelByMac = new Map(args.labels.map((l) => [l.mac.toLowerCase(), l]));

  const devices = new Map<string, WifiDevice>();
  const upsert = (mac: string, contract: ContractRef, how: DeviceHow, extra: Partial<WifiDevice>, guest?: GuestRecord) => {
    const key = mac.toLowerCase();
    const cur = devices.get(key);
    const seen = guest && seenAt(guest) > 0 ? new Date(seenAt(guest)).toISOString() : null;
    if (cur) {
      if (!cur.how.includes(how)) cur.how.push(how);
      cur.memberName ??= extra.memberName ?? null;
      cur.seat ??= extra.seat ?? null;
      cur.hostname ??= guest?.hostname ?? null;
      if (seen && (!cur.lastSeen || seen > cur.lastSeen)) cur.lastSeen = seen;
      return;
    }
    devices.set(key, {
      mac: key,
      label: labelByMac.get(key)?.label ?? null,
      memberName: extra.memberName ?? null,
      hostname: guest?.hostname ?? null,
      how: [how],
      seat: extra.seat ?? null,
      contractId: contract.id,
      contractNumber: contract.contract_number,
      lastSeen: seen,
    });
  };

  for (const g of args.guests) {
    const note = g.name ?? g.code;
    if (!note) continue;
    const seat = note.match(SEAT_NOTE);
    if (seat) {
      const contract = byNumber.get(seat[1]);
      const issuance = contract ? liveIssuance.get(`${contract.id}:${Number(seat[2])}`) : undefined;
      if (contract && issuance) {
        upsert(g.mac, contract, "seat", { seat: Number(seat[2]), memberName: issuance.member_name }, g);
        continue;
      }
    }
    const adhocId = adhocContractByNote.get(note);
    if (adhocId) upsert(g.mac, byId.get(adhocId) as ContractRef, "adhoc", {}, g);
  }

  // A label linked to one of his contracts counts even when the console no longer lists the guest.
  const guestByMac = new Map(args.guests.map((g) => [g.mac.toLowerCase(), g]));
  for (const l of args.labels) {
    const contract = l.contract_id ? byId.get(l.contract_id) : undefined;
    if (contract) upsert(l.mac, contract, "label", {}, guestByMac.get(l.mac.toLowerCase()));
  }

  return [...devices.values()].sort((a, b) => (a.seat ?? 1e9) - (b.seat ?? 1e9) || a.mac.localeCompare(b.mac));
}
