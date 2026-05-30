import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const addonSchema = z.object({
  description: z.string().min(1).max(200),
  amount: z.number().positive(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effective_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  is_active: z.boolean().optional().default(true),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_addons")
    .select("*")
    .eq("contract_id", id)
    .order("effective_from", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const result = addonSchema.safeParse(body);
  if (!result.success) return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const adminSupabase = createAdminClient();
  const { data, error } = await adminSupabase
    .from("contract_addons")
    .insert({
      contract_id: id,
      description: result.data.description,
      amount: result.data.amount,
      effective_from: result.data.effective_from,
      effective_until: result.data.effective_until ?? null,
      is_active: result.data.is_active,
      created_by: dbUser?.id ?? null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Auto-update any existing UNSENT draft billing statements that overlap this add-on's date range.
  // Sent statements are locked — never touched.
  try {
    const { data: draftStmts } = await adminSupabase
      .from("billing_statements")
      .select("id, subtotal, tax_percentage, cgst_amount, sgst_amount, line_items, fixed_amount, period_end")
      .eq("contract_id", id)
      .eq("status", "draft")
      .is("proforma_sent_at", null);

    for (const stmt of (draftStmts ?? [])) {
      // Check add-on is active during the statement's period
      const periodEnd = stmt.period_end as string;
      const addonFrom = result.data.effective_from;
      const addonUntil = result.data.effective_until;
      if (addonFrom > periodEnd) continue;
      if (addonUntil && addonUntil < periodEnd) continue;

      // Check add-on isn't already in the line_items
      const sections: Record<string, unknown>[] = (stmt.line_items as Record<string, unknown>[]) || [];
      const alreadyAdded = sections.some(sec =>
        ((sec.items as Record<string, unknown>[]) || []).some((item: Record<string, unknown>) =>
          item.description === result.data.description && item.amount === result.data.amount
        )
      );
      if (alreadyAdded) continue;

      // Inject add-on into the prepaid rent section
      const newSections = sections.map(sec => {
        const label = ((sec.label as string) || "").toLowerCase();
        if (label.includes("prepaid rent") || label.includes("rent")) {
          const items = [...((sec.items as Record<string, unknown>[]) || []), {
            description: result.data.description,
            amount: result.data.amount,
          }];
          const secSub = (sec.subtotal as number || 0) + result.data.amount;
          return { ...sec, items, subtotal: secSub };
        }
        return sec;
      });

      const newSub = (stmt.subtotal as number || 0) + result.data.amount;
      const taxPct = (stmt.tax_percentage as number) || 18;
      const cgst = Math.round(newSub * taxPct / 200);
      const sgst = Math.round(newSub * taxPct / 200);

      await adminSupabase.from("billing_statements").update({
        subtotal: newSub,
        fixed_amount: newSub,
        tax_amount: cgst + sgst,
        total_amount: newSub + cgst + sgst,
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: 0,
        line_items: newSections,
      }).eq("id", stmt.id);
    }
  } catch {
    // Non-fatal — statement update failure doesn't block add-on creation
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser?.id ?? "",
    changes: { addon_added: { old: null, new: result.data.description } },
  });

  return NextResponse.json({ data }, { status: 201 });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { addon_id, ...fields } = body;
  if (!addon_id) return NextResponse.json({ error: "addon_id required" }, { status: 400 });

  const allowed: Record<string, unknown> = {};
  if (fields.description !== undefined) allowed.description = fields.description;
  if (fields.amount !== undefined) allowed.amount = fields.amount;
  if (fields.effective_from !== undefined) allowed.effective_from = fields.effective_from;
  if (fields.effective_until !== undefined) allowed.effective_until = fields.effective_until;
  if (fields.is_active !== undefined) allowed.is_active = fields.is_active;
  allowed.updated_at = new Date().toISOString();

  const adminSupabase = createAdminClient();
  const { data, error } = await adminSupabase
    .from("contract_addons")
    .update(allowed)
    .eq("id", addon_id)
    .eq("contract_id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
