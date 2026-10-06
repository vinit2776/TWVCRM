import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ADHOC_ATTRIBUTION_PURPOSES } from "@/lib/constants";

// Attributing an ad-hoc invoice to a contract has billing consequences — a
// 'prorata_first_invoice' attribution can unblock the contract activation
// payment gate — so it is deliberately narrower than invoice creation
// (admin/manager/sales_rep/floor_manager). Sales should not hold a lever on
// that gate.
const ATTRIBUTION_ROLES = ["admin", "accounts"];

const attributionSchema = z.object({
  contract_id: z.string().uuid("A valid contract must be selected"),
  purpose: z.enum(ADHOC_ATTRIBUTION_PURPOSES, {
    message: "Select what this invoice covers",
  }),
});

async function authorize(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !ATTRIBUTION_ROLES.includes(dbUser.role)) {
    return {
      error: NextResponse.json(
        { error: "Only admin and accounts can attribute an invoice to a contract" },
        { status: 403 }
      ),
    };
  }
  return { dbUser };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { error: authError, dbUser } = await authorize(supabase);
  if (authError) return authError;

  const body = await request.json();
  const result = attributionSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }
  const { contract_id, purpose } = result.data;

  const { data: invoice } = await supabase
    .from("proforma_invoices")
    .select("id, invoice_number, lead_id, status, total_amount, contract_id, attribution_purpose")
    .eq("id", id)
    .single();

  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  // A cancelled invoice never collected anything, so attributing it would put a
  // phantom collection against the contract — and, for the pro-rata purpose,
  // could open the activation gate on money that was never received.
  if (invoice.status === "cancelled") {
    return NextResponse.json(
      { error: "A cancelled invoice can't be attributed to a contract." },
      { status: 400 }
    );
  }

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, contract_number, lead_id")
    .eq("id", contract_id)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  // Both records must belong to the same customer. Without this an invoice
  // could be attributed to an unrelated contract, which would both misstate
  // that contract's receivables and let one customer's payment unblock
  // another's activation.
  if (invoice.lead_id && contract.lead_id && invoice.lead_id !== contract.lead_id) {
    return NextResponse.json(
      { error: "Invoice and contract belong to different customers." },
      { status: 400 }
    );
  }

  // Security-deposit attribution moves money in the customer's deposit pool, so
  // it runs in one transaction (RPC, service role) rather than as a plain
  // column update: the credit and the attribution either both happen or neither.
  const admin = createAdminClient();
  let depositTopupId: string | null = null;

  if (invoice.attribution_purpose === "security_deposit" && purpose !== "security_deposit") {
    // Re-labelled away from security deposit: take the credit back out first.
    const { data: released } = await admin.rpc("release_invoice_security_deposit", {
      p_invoice_id: id,
      p_actor: dbUser!.id,
      p_reason: `Re-attributed as ${purpose}`,
    });
    const releaseResult = Array.isArray(released) ? released[0] : released;
    if (!releaseResult?.success) {
      return NextResponse.json(
        { error: releaseResult?.error ?? "Could not remove the existing deposit credit" },
        { status: 409 }
      );
    }
  }

  if (purpose === "security_deposit") {
    const { data: credited, error: rpcError } = await admin.rpc("attribute_invoice_as_security_deposit", {
      p_invoice_id: id,
      p_contract_id: contract_id,
      p_actor: dbUser!.id,
    });
    const creditResult = Array.isArray(credited) ? credited[0] : credited;
    if (rpcError || !creditResult?.success) {
      return NextResponse.json(
        { error: creditResult?.error ?? rpcError?.message ?? "Could not credit the deposit pool" },
        { status: creditResult ? 400 : 500 }
      );
    }
    depositTopupId = creditResult.topup_id as string;
  }

  const { data: updated, error } = purpose === "security_deposit"
    ? await supabase.from("proforma_invoices").select("*").eq("id", id).single()
    : await supabase
        .from("proforma_invoices")
        .update({
          contract_id,
          attribution_purpose: purpose,
          attributed_at: new Date().toISOString(),
          attributed_by: dbUser!.id,
        })
        .eq("id", id)
        .select("*")
        .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "invoice",
    entityId: id,
    action: "invoice_attributed",
    performedBy: dbUser!.id,
    changes: {
      contract_id: { old: invoice.contract_id, new: contract_id },
      contract_number: { old: null, new: contract.contract_number },
      attribution_purpose: { old: invoice.attribution_purpose, new: purpose },
      ...(depositTopupId ? { deposit_pool_credit_topup_id: { old: null, new: depositTopupId } } : {}),
    },
  });

  // Mirror onto the contract's own trail — someone auditing why a contract
  // activated should not have to know to go looking at the invoice.
  logAudit(supabase, {
    entityType: "contract",
    entityId: contract_id,
    action: "invoice_attributed",
    performedBy: dbUser!.id,
    changes: {
      invoice_number: { old: null, new: invoice.invoice_number },
      amount: { old: null, new: invoice.total_amount },
      attribution_purpose: { old: null, new: purpose },
      ...(depositTopupId ? { deposit_pool_credit_topup_id: { old: null, new: depositTopupId } } : {}),
    },
  });

  return NextResponse.json({ data: updated });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { error: authError, dbUser } = await authorize(supabase);
  if (authError) return authError;

  const { data: invoice } = await supabase
    .from("proforma_invoices")
    .select("id, invoice_number, contract_id, attribution_purpose")
    .eq("id", id)
    .single();

  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (!invoice.contract_id) {
    return NextResponse.json(
      { error: "This invoice is not attributed to a contract." },
      { status: 400 }
    );
  }

  // A security-deposit attribution credited the customer's deposit pool; take
  // that back before clearing the label, and refuse if it has been drawn on.
  if (invoice.attribution_purpose === "security_deposit") {
    const { data: released } = await createAdminClient().rpc("release_invoice_security_deposit", {
      p_invoice_id: id,
      p_actor: dbUser!.id,
      p_reason: "Attribution removed",
    });
    const releaseResult = Array.isArray(released) ? released[0] : released;
    if (!releaseResult?.success) {
      return NextResponse.json(
        { error: releaseResult?.error ?? "Could not remove the deposit credit" },
        { status: 409 }
      );
    }
  }

  // Cleared together — the CHECK constraint forbids a purpose without a contract.
  const { error } = await supabase
    .from("proforma_invoices")
    .update({
      contract_id: null,
      attribution_purpose: null,
      attributed_at: null,
      attributed_by: null,
    })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "invoice",
    entityId: id,
    action: "invoice_attribution_cleared",
    performedBy: dbUser!.id,
    changes: {
      contract_id: { old: invoice.contract_id, new: null },
      attribution_purpose: { old: invoice.attribution_purpose, new: null },
    },
  });

  logAudit(supabase, {
    entityType: "contract",
    entityId: invoice.contract_id,
    action: "invoice_attribution_cleared",
    performedBy: dbUser!.id,
    changes: {
      invoice_number: { old: invoice.invoice_number, new: null },
      attribution_purpose: { old: invoice.attribution_purpose, new: null },
    },
  });

  return NextResponse.json({ success: true });
}
