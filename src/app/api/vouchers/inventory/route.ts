import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { VOUCHER_LOW_STOCK_THRESHOLD } from "@/lib/constants";
import { getValidityLabel } from "@/lib/utils";
import type { VoucherStockLevel } from "@/types";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch all vouchers and group in JS (simple, no RPC needed)
  const { data: allVouchers, error: fetchError } = await supabase
    .from("voucher_repository")
    .select("validity_days, status");

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const groups = buildInventory(allVouchers || []);
  return NextResponse.json(groups);
}

function getStockLevel(available: number): VoucherStockLevel {
  if (available === 0) return "red";
  if (available < VOUCHER_LOW_STOCK_THRESHOLD) return "amber";
  return "green";
}

function buildInventory(
  rows: Array<{ validity_days: number | null; status: string }>
) {
  const groupMap = new Map<
    string,
    { validity_days: number | null; available: number; issued: number; total: number }
  >();

  for (const row of rows) {
    const key = row.validity_days == null ? "null" : String(row.validity_days);
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        validity_days: row.validity_days,
        available: 0,
        issued: 0,
        total: 0,
      });
    }
    const g = groupMap.get(key)!;
    g.total += 1;
    if (row.status === "available") g.available += 1;
    else if (row.status === "issued") g.issued += 1;
  }

  const data = Array.from(groupMap.values())
    .map((g) => ({
      ...g,
      label: getValidityLabel(g.validity_days),
      stock_level: getStockLevel(g.available),
    }))
    .sort((a, b) => {
      if (a.validity_days === null) return 1;
      if (b.validity_days === null) return -1;
      return a.validity_days - b.validity_days;
    });

  const lowStockAlerts = data.filter(
    (g) => g.stock_level === "red" || g.stock_level === "amber"
  );

  return {
    data,
    low_stock_alerts: lowStockAlerts,
    unclassified: data.find((g) => g.validity_days === null) || null,
  };
}
