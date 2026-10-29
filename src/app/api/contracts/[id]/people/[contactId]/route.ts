import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";
import { isContractOperational } from "@/lib/constants";
import { giveAccess } from "@/lib/contract-people";
import { provisionMemberDoor } from "@/lib/contract-member-door";
import { revokeUnifiIssuances } from "@/lib/contract-lifecycle";
import { setUserActive } from "@/lib/cosec";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("give_access"),
    give_voucher: z.boolean().default(true),
    give_door: z.boolean().default(true),
  }),
  z.object({ action: z.literal("issue_door") }),
  z.object({
    action: z.literal("leave"),
    left_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({ action: z.literal("reactivate") }),
]);

/**
 * POST /api/contracts/[id]/people/[contactId]
 * Per-person actions:
 *   give_access  contact-only → seat-holding member (sends nothing)
 *   issue_door   provision door access and text the enrollment PIN (sends an SMS)
 *   leave        mark as left: revoke voucher + door access, free the seat, keep the record
 *   reactivate   bring a previous person back (needs a free seat; access is re-issued afterwards)
 * Issuing a voucher stays on POST /api/contracts/[id]/vouchers (with member_id).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; contactId: string }> }
) {
  const { id: contractId, contactId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = actionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const body = parsed.data;

  const admin = createAdminClient();
  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const { data: contract } = await admin
    .from("contracts")
    .select("id, seats, status, end_date, location_id, contract_number")
    .eq("id", contractId)
    .maybeSingle();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const { data: contact } = await admin
    .from("contract_contacts")
    .select("id, full_name, phone, is_active, source_member_id")
    .eq("id", contactId)
    .eq("contract_id", contractId)
    .maybeSingle();
  if (!contact) return NextResponse.json({ error: "Person not found" }, { status: 404 });

  const audit = (change: string) => {
    if (dbUser?.id) {
      logAudit(supabase, {
        entityType: "contract",
        entityId: contractId,
        action: "update",
        performedBy: dbUser.id,
        changes: { [change]: { old: null, new: contact.full_name } },
      });
    }
  };

  // ── give_access ────────────────────────────────────────────────────────────
  if (body.action === "give_access") {
    const result = await giveAccess(admin, {
      contractId,
      contactId,
      needsVoucher: body.give_voucher,
      needsDoor: body.give_door,
      addedBy: dbUser?.id ?? null,
    });
    if (!result.ok) {
      if (result.code === "SEATS_FULL") {
        return NextResponse.json(
          { error: `All ${result.seats} seats are in use. Mark someone as left or increase the seats first.`, code: result.code },
          { status: 409 }
        );
      }
      if (result.code === "PHONE_REQUIRED") {
        return NextResponse.json({ error: "Add a phone number first, it is needed for door access", code: result.code }, { status: 400 });
      }
      if (result.code === "ALREADY_HAS_ACCESS") {
        return NextResponse.json({ error: "This person already has access set up", code: result.code }, { status: 409 });
      }
      return NextResponse.json({ error: result.message ?? "Person not found" }, { status: result.code === "NOT_FOUND" ? 404 : 500 });
    }
    audit("access_given");
    return NextResponse.json({ data: { memberId: result.memberId } });
  }

  // Everything below needs the person to be a member.
  const memberId = contact.source_member_id as string | null;
  if (!memberId) return NextResponse.json({ error: "This person is a contact only, give them access first" }, { status: 400 });

  const { data: member } = await admin
    .from("contract_members")
    .select("id, name, phone, is_active, needs_door")
    .eq("id", memberId)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: "Member record not found" }, { status: 404 });

  // ── issue_door ─────────────────────────────────────────────────────────────
  if (body.action === "issue_door") {
    if (!member.is_active) return NextResponse.json({ error: "This person has left the contract" }, { status: 409 });
    if (!isContractOperational({ status: contract.status, end_date: contract.end_date })) {
      return NextResponse.json({ error: "Door access can only be issued for active contracts" }, { status: 400 });
    }
    const { data: live } = await admin
      .from("cosec_access_users")
      .select("id")
      .eq("entity_id", memberId)
      .eq("user_type", "member")
      .not("enrollment_status", "in", "(blocked,deleted)")
      .limit(1);
    if (live && live.length > 0) return NextResponse.json({ error: "Door access is already set up for this person" }, { status: 409 });

    const result = await provisionMemberDoor(
      admin,
      { id: contract.id, location_id: contract.location_id, end_date: contract.end_date },
      { id: member.id, name: member.name, phone: member.phone }
    );
    if (result.devices === 0) {
      return NextResponse.json({ error: "No door devices are set up for this location, so nothing was provisioned" }, { status: 422 });
    }
    if (result.provisioned === 0) {
      return NextResponse.json({ error: "Could not reach the door devices. Try again, or ask IT to check them." }, { status: 502 });
    }
    audit("door_access_issued");
    return NextResponse.json({ data: result });
  }

  // ── leave ──────────────────────────────────────────────────────────────────
  if (body.action === "leave") {
    if (!member.is_active) return NextResponse.json({ error: "Already marked as left" }, { status: 409 });
    const now = new Date().toISOString();
    const leftOn = body.left_on ?? now.slice(0, 10);

    await admin
      .from("contract_members")
      .update({ is_active: false, left_on: leftOn, left_reason: body.reason || null, updated_at: now })
      .eq("id", memberId);
    await admin.from("contract_contacts").update({ is_active: false, updated_at: now }).eq("id", contactId);

    // Voucher: delete on the controller if it is a live UniFi voucher, then close the issuance.
    try {
      const { data: issuances } = await admin
        .from("voucher_issuances")
        .select("id, voucher_id, unifi_voucher_id, unifi_console_id")
        .eq("member_id", memberId)
        .eq("is_active", true);
      if (issuances && issuances.length > 0) {
        await revokeUnifiIssuances(issuances, contract.location_id, contract.contract_number);
        await admin
          .from("voucher_issuances")
          .update({ is_active: false, revoked_at: now, revoke_reason: body.reason ? `Left the contract: ${body.reason}` : "Left the contract" })
          .in("id", issuances.map((i) => i.id));
        const voucherIds = issuances.map((i) => i.voucher_id).filter(Boolean) as string[];
        if (voucherIds.length > 0) {
          // "revoked", not "available": the code was handed to someone who has now left.
          await admin.from("voucher_repository").update({ status: "revoked" }).in("id", voucherIds);
        }
      }
    } catch (err) {
      console.error("[people] voucher revoke on leave failed:", err);
    }

    // Door access: block on every device.
    try {
      const { data: accessUsers } = await admin
        .from("cosec_access_users")
        .select("id, cosec_user_id, device:cosec_devices(device_ip, device_port, device_password)")
        .eq("entity_id", memberId)
        .eq("user_type", "member")
        .not("enrollment_status", "in", "(blocked,deleted)");
      await Promise.allSettled(
        (accessUsers ?? []).map(async (au) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- joined relation typed as array by the client
          const dev = au.device as any;
          if (dev) {
            try {
              await setUserActive({ ip: dev.device_ip, port: dev.device_port, password: dev.device_password }, au.cosec_user_id, false);
            } catch { /* device offline: the DB row is still blocked below */ }
          }
          await admin.from("cosec_access_users").update({ enrollment_status: "blocked", blocked_at: now, updated_at: now }).eq("id", au.id);
        })
      );
    } catch (err) {
      console.error("[people] door block on leave failed:", err);
    }

    audit("person_left");
    return NextResponse.json({ data: { leftOn } });
  }

  // ── reactivate ─────────────────────────────────────────────────────────────
  if (member.is_active) return NextResponse.json({ error: "This person is already active" }, { status: 409 });
  const { count } = await admin
    .from("contract_members")
    .select("id", { count: "exact", head: true })
    .eq("contract_id", contractId)
    .eq("is_active", true);
  if ((count ?? 0) >= (contract.seats ?? 0)) {
    return NextResponse.json({ error: `All ${contract.seats} seats are in use. Free a seat or increase the seats first.`, code: "SEATS_FULL" }, { status: 409 });
  }
  const now = new Date().toISOString();
  await admin
    .from("contract_members")
    .update({ is_active: true, left_on: null, left_reason: null, updated_at: now })
    .eq("id", memberId);
  await admin.from("contract_contacts").update({ is_active: true, updated_at: now }).eq("id", contactId);
  audit("person_reactivated");
  return NextResponse.json({ data: { memberId } });
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email().or(z.literal("")).optional(),
  phone: z.string().trim().min(10).max(20).optional(),
});

/**
 * PATCH /api/contracts/[id]/people/[contactId]
 * Fix a person's name, email or phone (for example the missing email a voucher
 * needs). Updates the contact and, when they hold a seat, the linked member too,
 * so the two records never disagree.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; contactId: string }> }
) {
  const { id: contractId, contactId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const body = parsed.data;

  const admin = createAdminClient();
  const { data: contact } = await admin
    .from("contract_contacts")
    .select("id, source_member_id")
    .eq("id", contactId)
    .eq("contract_id", contractId)
    .maybeSingle();
  if (!contact) return NextResponse.json({ error: "Person not found" }, { status: 404 });

  const now = new Date().toISOString();
  const contactUpdate: Record<string, unknown> = { updated_at: now };
  const memberUpdate: Record<string, unknown> = { updated_at: now };
  if (body.name !== undefined) { contactUpdate.full_name = body.name; memberUpdate.name = body.name; }
  if (body.email !== undefined) { contactUpdate.email = body.email || null; memberUpdate.email = body.email || null; }
  if (body.phone !== undefined) { contactUpdate.phone = body.phone; memberUpdate.phone = body.phone; }

  const { error } = await admin.from("contract_contacts").update(contactUpdate).eq("id", contactId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (contact.source_member_id) {
    const { error: memberErr } = await admin.from("contract_members").update(memberUpdate).eq("id", contact.source_member_id);
    if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
