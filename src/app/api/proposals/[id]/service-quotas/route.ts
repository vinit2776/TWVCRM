import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("proposal_service_quotas")
    .select("monthly_quota, overage_rate, service:service_catalog(name, unit_label)")
    .eq("proposal_id", id)
    .gt("monthly_quota", 0);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    monthly_quota: number;
    overage_rate: number;
    service: { name: string; unit_label: string } | null;
  };

  const mapped = (data as unknown as Row[])
    .filter((r) => r.service)
    .map((r) => ({
      name: r.service!.name,
      unit_label: r.service!.unit_label,
      monthly_quota: r.monthly_quota,
      overage_rate: r.overage_rate,
    }));

  return NextResponse.json({ data: mapped });
}
