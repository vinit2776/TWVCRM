import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";
import {
  addPerson,
  computeAccessSetup,
  DEFAULT_ACCESS_ROLES,
  PERSON_ROLES,
  type PersonAccessRow,
} from "@/lib/contract-people";

const addSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(PERSON_ROLES).default("occupant"),
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  // Default depends on the role (occupants get access, finance/signatory don't).
  give_voucher: z.boolean().optional(),
  give_door: z.boolean().optional(),
  use_existing: z.boolean().optional(),
});

/**
 * GET /api/contracts/[id]/people
 * Everyone on the contract (contacts, with their member/access state) plus the
 * computed setup state: what is pending and whose turn it is.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const [{ data: contract }, { data: contacts }] = await Promise.all([
    admin.from("contracts").select("id, seats, status, end_date, location_id").eq("id", id).maybeSingle(),
    admin
      .from("contract_contacts")
      .select("id, full_name, email, phone, contact_role, is_active, source_member_id, created_at")
      .eq("contract_id", id)
      .order("created_at"),
  ]);
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const memberIds = (contacts ?? []).map((c) => c.source_member_id).filter(Boolean) as string[];

  const [membersRes, issuancesRes, accessRes] = await Promise.all([
    memberIds.length
      ? admin
          .from("contract_members")
          .select("id, is_active, needs_voucher, needs_door, left_on, left_reason, created_at")
          .in("id", memberIds)
      : Promise.resolve({ data: [] as never[] }),
    memberIds.length
      ? admin
          .from("voucher_issuances")
          .select("id, member_id, seat_number, valid_until, issued_at, emailed_at, is_active, revoked_at")
          .in("member_id", memberIds)
      : Promise.resolve({ data: [] as never[] }),
    memberIds.length
      ? admin
          .from("cosec_access_users")
          .select("entity_id, enrollment_status, provisioned_at, blocked_at, valid_until")
          .eq("user_type", "member")
          .in("entity_id", memberIds)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const memberById = new Map((membersRes.data ?? []).map((m: { id: string }) => [m.id, m]));
  type Issuance = {
    member_id: string; seat_number: number; valid_until: string | null;
    issued_at: string | null; emailed_at: string | null; is_active: boolean; revoked_at: string | null;
  };
  const issuanceByMember = new Map<string, Issuance>();
  const revokedAtByMember = new Map<string, string>();
  for (const i of (issuancesRes.data ?? []) as Issuance[]) {
    if (i.is_active) issuanceByMember.set(i.member_id, i);
    else if (i.revoked_at) revokedAtByMember.set(i.member_id, i.revoked_at);
  }
  // Door PIN emails are recorded on the contract's audit trail (one row per attempt).
  type PinChange = { member_id: string; purpose: string; email: string | null; sent: boolean; reason: string | null; valid_until: string | null };
  const { data: pinRows } = await admin
    .from("audit_trail")
    .select("changes, performed_by, created_at")
    .eq("entity_type", "contract")
    .eq("entity_id", id)
    .eq("action", "email_sent")
    .order("created_at", { ascending: false })
    .limit(500);
  const pinByMember = new Map<string, { latest: PinChange; at: string; by: string | null; attempts: number }>();
  for (const r of (pinRows ?? []) as { changes: { door_pin?: { new?: PinChange } } | null; performed_by: string | null; created_at: string }[]) {
    const c = r.changes?.door_pin?.new;
    if (!c?.member_id) continue;
    const prev = pinByMember.get(c.member_id);
    if (prev) prev.attempts += 1;
    else pinByMember.set(c.member_id, { latest: c, at: r.created_at, by: r.performed_by, attempts: 1 });
  }
  const byIds = [...new Set([...pinByMember.values()].map((v) => v.by).filter(Boolean))] as string[];
  const { data: byUsers } = byIds.length
    ? await admin.from("users").select("id, full_name").in("id", byIds)
    : { data: [] as { id: string; full_name: string }[] };
  const userName = new Map((byUsers ?? []).map((u: { id: string; full_name: string }) => [u.id, u.full_name]));
  const doorValidUntil = new Map<string, string>();

  const doorStatuses = new Map<string, string[]>();
  const doorAt = new Map<string, string>();
  for (const a of (accessRes.data ?? []) as { entity_id: string; enrollment_status: string; provisioned_at: string | null; blocked_at: string | null; valid_until: string | null }[]) {
    if (a.valid_until && !doorValidUntil.has(a.entity_id)) doorValidUntil.set(a.entity_id, a.valid_until);
    const list = doorStatuses.get(a.entity_id) ?? [];
    list.push(a.enrollment_status);
    doorStatuses.set(a.entity_id, list);
    if (a.provisioned_at && (!doorAt.has(a.entity_id) || a.provisioned_at < doorAt.get(a.entity_id)!)) doorAt.set(a.entity_id, a.provisioned_at);
    if (a.blocked_at && !revokedAtByMember.has(a.entity_id)) revokedAtByMember.set(a.entity_id, a.blocked_at);
  }

  type MemberRow = {
    id: string;
    is_active: boolean;
    needs_voucher: boolean;
    needs_door: boolean;
    left_on: string | null;
    left_reason: string | null;
  };

  const people = (contacts ?? []).map((c) => {
    const member = c.source_member_id ? (memberById.get(c.source_member_id) as MemberRow | undefined) : undefined;
    const issuance = c.source_member_id ? issuanceByMember.get(c.source_member_id) : undefined;
    const statuses = c.source_member_id ? (doorStatuses.get(c.source_member_id) ?? []) : [];
    const liveStatuses = statuses.filter((s) => s !== "blocked" && s !== "deleted");
    return {
      contactId: c.id as string,
      memberId: (c.source_member_id as string | null) ?? null,
      name: c.full_name as string,
      role: c.contact_role as string,
      email: (c.email as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      isActive: member ? member.is_active : (c.is_active as boolean),
      needsVoucher: member?.needs_voucher ?? false,
      needsDoor: member?.needs_door ?? false,
      voucherIssued: !!issuance,
      voucher: issuance
        ? { seatNumber: issuance.seat_number, validUntil: issuance.valid_until, issuedAt: issuance.issued_at, emailedAt: issuance.emailed_at }
        : null,
      doorIssuedAt: c.source_member_id ? (doorAt.get(c.source_member_id) ?? null) : null,
      doorValidUntil: c.source_member_id ? (doorValidUntil.get(c.source_member_id) ?? null) : null,
      doorPin: (() => {
        const v = c.source_member_id ? pinByMember.get(c.source_member_id) : undefined;
        if (!v) return null;
        return {
          at: v.at,
          by: v.by ? (userName.get(v.by) ?? "A team member") : "System",
          sent: v.latest.sent,
          reason: v.latest.reason,
          email: v.latest.email,
          purpose: v.latest.purpose,
          attempts: v.attempts,
        };
      })(),
      accessEndedAt: c.source_member_id ? (revokedAtByMember.get(c.source_member_id) ?? null) : null,
      doorEnrolled: liveStatuses.length > 0,
      doorStatuses: liveStatuses,
      leftOn: member?.left_on ?? null,
      leftReason: member?.left_reason ?? null,
    };
  });

  const setup = computeAccessSetup(people satisfies PersonAccessRow[], contract.seats ?? 0);

  return NextResponse.json({
    data: { seats: contract.seats ?? 0, contractStatus: contract.status, people, setup },
  });
}

/**
 * POST /api/contracts/[id]/people
 * Add a person. Records the contact (and, if they are meant to get access, the
 * seat-holding member). Issues nothing and sends nothing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = addSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const body = parsed.data;

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  const defaultAccess = DEFAULT_ACCESS_ROLES.includes(body.role);

  const result = await addPerson(createAdminClient(), {
    contractId: id,
    name: body.name,
    role: body.role,
    email: body.email || null,
    phone: body.phone || null,
    needsVoucher: body.give_voucher ?? defaultAccess,
    needsDoor: body.give_door ?? defaultAccess,
    addedBy: dbUser?.id ?? null,
    useExisting: body.use_existing,
  });

  if (!result.ok) {
    switch (result.code) {
      case "DUPLICATE":
        return NextResponse.json(
          { error: `${result.existing.name} is already on this contract`, code: result.code, existing: result.existing },
          { status: 409 }
        );
      case "SEATS_FULL":
        return NextResponse.json(
          { error: `All ${result.seats} seats are in use. Mark someone as left or increase the seats first.`, code: result.code },
          { status: 409 }
        );
      case "PHONE_REQUIRED":
        return NextResponse.json(
          { error: "A phone number is needed to give door access", code: result.code },
          { status: 400 }
        );
      case "EMAIL_REQUIRED":
        return NextResponse.json(
          { error: "An email address is needed: the door PIN and WiFi voucher are sent by email", code: result.code },
          { status: 400 }
        );
      default:
        return NextResponse.json({ error: result.message }, { status: 500 });
    }
  }

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { person_added: { old: null, new: body.name } },
    });
  }

  return NextResponse.json({ data: result }, { status: 201 });
}
