import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges, logView } from "@/lib/audit";
import { updateProposalSchema } from "@/lib/validations";
import { PROPOSAL_EDITABLE_STATUSES } from "@/lib/constants";

const CONTENT_FIELDS = [
  "items",
  "tax_percentage",
  "discount_percentage",
  "title",
  "description",
  "terms_and_conditions",
  "notes",
  "valid_until",
  "service_quotas",
  "complimentary_items",
  "security_deposit_months",
  "security_deposit_amount",
] as const;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, location_id, entity_type, billing_emails), location:locations!proposals_location_id_fkey(id, name, code, proposal_amenity_icons), deposit_payment_recorded_by_user:users!proposals_deposit_payment_recorded_by_fkey(id, full_name), deposit_waiver_verified_by_user:users!proposals_deposit_waiver_verified_by_fkey(id, full_name)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    await logView(supabase, { entityType: "proposal", entityId: id, performedBy: dbUser.id });
  }

  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  const { data: oldProposal } = await supabase.from("proposals").select("*").eq("id", id).single();
  if (!oldProposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const allowedFields: Record<string, unknown> = {};

  if (body.status) allowedFields.status = body.status;
  if (body.location_id !== undefined) allowedFields.location_id = body.location_id || null;
  if (body.sent_at) allowedFields.sent_at = body.sent_at;
  if (body.viewed_at) allowedFields.viewed_at = body.viewed_at;
  if (body.accepted_at) allowedFields.accepted_at = body.accepted_at;
  if (body.rejected_at) allowedFields.rejected_at = body.rejected_at;
  if (body.rejection_reason !== undefined) allowedFields.rejection_reason = body.rejection_reason || null;
  // Allow clearing razorpay links for regeneration
  if (body.razorpay_payment_link_id !== undefined) allowedFields.razorpay_payment_link_id = body.razorpay_payment_link_id;
  if (body.razorpay_payment_link_url !== undefined) allowedFields.razorpay_payment_link_url = body.razorpay_payment_link_url;
  if (body.deposit_razorpay_link_id !== undefined) allowedFields.deposit_razorpay_link_id = body.deposit_razorpay_link_id;
  if (body.deposit_razorpay_link_url !== undefined) allowedFields.deposit_razorpay_link_url = body.deposit_razorpay_link_url;
  if (body.occupation_start_date !== undefined) allowedFields.occupation_start_date = body.occupation_start_date;

  const contentFieldsInBody = CONTENT_FIELDS.filter((f) => body[f] !== undefined);
  if (contentFieldsInBody.length > 0) {
    if (!PROPOSAL_EDITABLE_STATUSES.includes(oldProposal.status)) {
      return NextResponse.json(
        { error: `Only draft, sent, viewed, or rejected proposals can be edited. This proposal is "${oldProposal.status}".` },
        { status: 400 }
      );
    }

    const contentBody: Record<string, unknown> = {};
    for (const f of contentFieldsInBody) contentBody[f] = body[f];
    const result = updateProposalSchema.safeParse(contentBody);
    if (!result.success) {
      const fieldErrors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return NextResponse.json({ error: `Validation failed: ${fieldErrors}`, details: result.error.issues }, { status: 400 });
    }

    // service_quotas lives in proposal_service_quotas, not a proposals column
    // (same split POST /api/proposals makes) — pulled out and persisted below.
    const { service_quotas, ...contentUpdates } = result.data;
    Object.assign(allowedFields, contentUpdates);

    // Pricing is derived server-side, never trusted from the client — same
    // formula as POST /api/proposals so create and edit stay in sync.
    if ("items" in result.data || "tax_percentage" in result.data || "discount_percentage" in result.data) {
      const items = (result.data.items ?? oldProposal.items) as { total: number }[];
      const taxPercentage = result.data.tax_percentage ?? oldProposal.tax_percentage;
      const discountPercentage = result.data.discount_percentage ?? oldProposal.discount_percentage;
      const subtotal = items.reduce((sum, item) => sum + item.total, 0);
      const taxAmount = subtotal * (taxPercentage / 100);
      const discountAmount = subtotal * (discountPercentage / 100);
      allowedFields.subtotal = subtotal;
      allowedFields.total_amount = subtotal + taxAmount - discountAmount;
    }

    if (service_quotas) {
      await supabase.from("proposal_service_quotas").delete().eq("proposal_id", id);
      if (service_quotas.length > 0) {
        const quotaRows = service_quotas.map((q) => ({
          proposal_id: id,
          service_id: q.service_id,
          monthly_quota: q.monthly_quota,
          overage_rate: q.overage_rate,
        }));
        await supabase.from("proposal_service_quotas").insert(quotaRows);
      }
    }
  }

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("proposals")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id && oldProposal) {
    logAudit(supabase, {
      entityType: "proposal",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldProposal as Record<string, unknown>, allowedFields),
    });
  }

  return NextResponse.json({ data });
}
