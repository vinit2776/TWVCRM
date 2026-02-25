import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const { data, error } = await supabase
    .from("purchase_order_items")
    .select(`
      id,
      quantity_ordered,
      quantity_received,
      unit,
      unit_price,
      total_amount,
      purchase_orders!inner(
        id,
        po_number,
        status,
        created_at,
        expected_delivery_date,
        actual_delivery_date,
        procurement_vendors(id, name),
        locations(id, name)
      )
    `)
    .eq("item_id", id)
    .order("created_at", { referencedTable: "purchase_orders", ascending: false })
    .limit(25);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data ?? [] });
}
