/**
 * Batch-resolves COSEC `entity_id` + `user_type` pairs (as stored on
 * access_logs / cosec_access_users) into display details for ISO register
 * exports — cardholder name, company, current cabin/desk, and card number.
 *
 * Modeled on the resolveEntityNames() pattern in
 * src/app/api/cosec/poll-now/route.ts, but standalone: that route's version
 * only returns a name and is left untouched (working code, out of scope).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any;

export interface EntityRef {
  entityId: string;
  userType: string | null;
}

export interface ResolvedEntity {
  name: string;
  company: string | null;
  cabin: string | null;
  cardNumber: string | null;
}

function refKey(ref: EntityRef): string {
  return `${ref.userType ?? "unknown"}:${ref.entityId}`;
}

export async function resolveEntityDetailsBatch(
  admin: AdminClient,
  refs: EntityRef[]
): Promise<Map<string, ResolvedEntity>> {
  const details = new Map<string, ResolvedEntity>();
  const byType = new Map<string, string[]>();
  for (const ref of refs) {
    if (!ref.entityId || !ref.userType) continue;
    if (!byType.has(ref.userType)) byType.set(ref.userType, []);
    byType.get(ref.userType)!.push(ref.entityId);
  }
  if (byType.size === 0) return details;

  const tasks: Promise<void>[] = [];

  if (byType.has("contract")) {
    const ids = byType.get("contract")!;
    tasks.push(
      (async () => {
        const [{ data: contracts }, { data: seats }] = await Promise.all([
          admin
            .from("contracts")
            .select("id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
            .in("id", ids),
          admin
            .from("space_seat_occupants")
            .select("contract_id, seat_label")
            .in("contract_id", ids)
            .eq("status", "active"),
        ]);
        const seatByContract = new Map<string, string>();
        for (const s of seats ?? []) {
          if (!seatByContract.has(s.contract_id)) seatByContract.set(s.contract_id, s.seat_label);
        }
        for (const c of contracts ?? []) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lead = c.lead as any;
          const name = `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || c.contract_number;
          details.set(refKey({ entityId: c.id, userType: "contract" }), {
            name,
            company: lead?.company ?? null,
            cabin: seatByContract.get(c.id) ?? null,
            cardNumber: null,
          });
        }
      })()
    );
  }

  if (byType.has("member")) {
    const ids = byType.get("member")!;
    tasks.push(
      (async () => {
        const { data: members } = await admin
          .from("contract_members")
          .select("id, name, contract_id")
          .in("id", ids);
        const contractIds = [...new Set((members ?? []).map((m: { contract_id: string }) => m.contract_id))];
        const [{ data: contracts }, { data: seats }] = contractIds.length
          ? await Promise.all([
              admin
                .from("contracts")
                .select("id, lead:leads!contracts_lead_id_fkey(company)")
                .in("id", contractIds),
              admin
                .from("space_seat_occupants")
                .select("contract_id, seat_label")
                .in("contract_id", contractIds)
                .eq("status", "active"),
            ])
          : [{ data: [] }, { data: [] }];
        const companyByContract = new Map<string, string | null>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const c of contracts ?? []) companyByContract.set(c.id, (c.lead as any)?.company ?? null);
        const seatByContract = new Map<string, string>();
        for (const s of seats ?? []) {
          if (!seatByContract.has(s.contract_id)) seatByContract.set(s.contract_id, s.seat_label);
        }
        for (const m of members ?? []) {
          details.set(refKey({ entityId: m.id, userType: "member" }), {
            name: m.name,
            company: companyByContract.get(m.contract_id) ?? null,
            cabin: seatByContract.get(m.contract_id) ?? null,
            cardNumber: null,
          });
        }
      })()
    );
  }

  if (byType.has("employee")) {
    const ids = byType.get("employee")!;
    tasks.push(
      (async () => {
        const { data: employees } = await admin.from("employees").select("id, full_name").in("id", ids);
        for (const e of employees ?? []) {
          details.set(refKey({ entityId: e.id, userType: "employee" }), {
            name: e.full_name,
            company: null,
            cabin: null,
            cardNumber: null,
          });
        }
      })()
    );
  }

  if (byType.has("booking")) {
    const ids = byType.get("booking")!;
    tasks.push(
      (async () => {
        const { data: bookings } = await admin
          .from("bookings")
          .select("id, booking_number, guest_name, guest_company")
          .in("id", ids);
        for (const b of bookings ?? []) {
          details.set(refKey({ entityId: b.id, userType: "booking" }), {
            name: b.guest_name || `Booking #${b.booking_number}`,
            company: b.guest_company ?? null,
            cabin: null,
            cardNumber: null,
          });
        }
      })()
    );
  }

  await Promise.all(tasks);

  // Card numbers: one extra pass, joined by (entity_id, user_type) across all types at once.
  const allEntityIds = [...new Set(refs.filter((r) => r.entityId && r.userType).map((r) => r.entityId))];
  if (allEntityIds.length > 0) {
    const { data: cardUsers } = await admin
      .from("cosec_access_users")
      .select("entity_id, user_type, nfc_card_number")
      .in("entity_id", allEntityIds)
      .not("nfc_card_number", "is", null);
    for (const cu of cardUsers ?? []) {
      const key = refKey({ entityId: cu.entity_id, userType: cu.user_type });
      const existing = details.get(key);
      if (existing && !existing.cardNumber) existing.cardNumber = cu.nfc_card_number;
    }
  }

  return details;
}
