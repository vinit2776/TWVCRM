import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createBillSchema = z.object({
  po_id: z.string().uuid().nullish(),
  vendor_id: z.string().uuid(),
  invoice_number: z.string().nullish(),
  invoice_date: z.string().min(1, "Invoice date is required"),
  due_date: z.string().nullish(),
  total_amount: z.number().positive("Total amount must be greater than 0"),
  notes: z.string().nullish(),
});

function generateBillNumber(count: number): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  return `BILL-${yy}${mm}-${seq}`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const paymentStatus = searchParams.get("payment_status");
  const vendorId = searchParams.get("vendor_id");
  const poId = searchParams.get("po_id");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;

  let query = supabase
    .from("vendor_bills")
    .select(
      `*, procurement_vendors(id, name), purchase_orders(id, po_number)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (paymentStatus) query = query.eq("payment_status", paymentStatus);
  if (vendorId) query = query.eq("vendor_id", vendorId);
  if (poId) query = query.eq("po_id", poId);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only managers and admins can create vendor bills" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createBillSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // Generate bill number
  const { count: existingCount } = await supabase
    .from("vendor_bills")
    .select("*", { count: "exact", head: true });

  const billNumber = generateBillNumber(existingCount ?? 0);

  const { data: bill, error: billError } = await supabase
    .from("vendor_bills")
    .insert({
      po_id: parsed.data.po_id ?? null,
      vendor_id: parsed.data.vendor_id,
      invoice_number: parsed.data.invoice_number ?? null,
      invoice_date: parsed.data.invoice_date,
      due_date: parsed.data.due_date ?? null,
      total_amount: parsed.data.total_amount,
      notes: parsed.data.notes ?? null,
      bill_number: billNumber,
      amount_paid: 0,
      payment_status: "unpaid",
      created_by: dbUser.id,
    })
    .select("id, bill_number")
    .single();

  if (billError) return NextResponse.json({ error: billError.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: bill.id,
    action: "create",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data: { id: bill.id, bill_number: bill.bill_number } }, { status: 201 });
}
