import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SpaceUnitType, SpaceUnit, SpaceAnalytics, FloorCUF, SpaceTypeOccupancy, SpaceRevenueRow } from "@/types";

const UNIT_TYPES: SpaceUnitType[] = ["hot_desk", "dedicated_desk", "private_cabin", "managed_office", "business_centre"];
const HOURLY_TYPES: ReadonlySet<SpaceUnitType> = new Set(["business_centre"]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch floors and active units with their allocations in parallel
  const [floorsResult, unitsResult] = await Promise.all([
    supabase
      .from("location_floors")
      .select("*")
      .eq("location_id", id)
      .order("sort_order"),
    supabase
      .from("space_units")
      .select(`
        *,
        active_allocations:contract_space_allocations(
          id, status, start_date, end_date,
          contract:contracts(id, contract_number, title, status)
        )
      `)
      .eq("location_id", id)
      .eq("is_active", true)
      .eq("active_allocations.status", "active"),
  ]);

  if (floorsResult.error) return NextResponse.json({ error: floorsResult.error.message }, { status: 500 });
  if (unitsResult.error) return NextResponse.json({ error: unitsResult.error.message }, { status: 500 });

  const floors = floorsResult.data || [];
  const units: SpaceUnit[] = (unitsResult.data || []) as unknown as SpaceUnit[];

  // ── CUF per floor ─────────────────────────────────────────────────────────
  const floorCUFs: FloorCUF[] = floors.map((f) => ({
    floor_id: f.id,
    floor_name: f.name,
    total_area_sqft: Number(f.total_area_sqft),
    leasable_area_sqft: Number(f.leasable_area_sqft),
    cuf: Number(f.total_area_sqft) > 0
      ? Number(f.leasable_area_sqft) / Number(f.total_area_sqft)
      : 0,
  }));

  const totalBuiltUp = floorCUFs.reduce((s, f) => s + f.total_area_sqft, 0);
  const totalLeasable = floorCUFs.reduce((s, f) => s + f.leasable_area_sqft, 0);
  const overallCUF = totalBuiltUp > 0 ? totalLeasable / totalBuiltUp : 0;

  // ── Occupancy per type ────────────────────────────────────────────────────
  const occupancy: SpaceTypeOccupancy[] = UNIT_TYPES.map((type) => {
    const typeUnits = units.filter((u) => u.type === type);
    const contractedUnits = typeUnits.filter(
      (u) => (u.active_allocations || []).some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any) => a.status === "active" && ["active", "renewed"].includes(a.contract?.status ?? "")
      )
    );
    const totalCap = typeUnits.reduce((s, u) => s + u.capacity, 0);
    const contractedCap = contractedUnits.reduce((s, u) => s + u.capacity, 0);
    return {
      type,
      total_units: typeUnits.length,
      total_capacity: totalCap,
      contracted_units: contractedUnits.length,
      contracted_capacity: contractedCap,
      occupancy_rate: totalCap > 0 ? contractedCap / totalCap : 0,
    };
  });

  // ── Revenue per type ──────────────────────────────────────────────────────
  // Hourly types (business_centre) don't contribute to monthly recurring revenue.
  const revenue: SpaceRevenueRow[] = UNIT_TYPES.map((type) => {
    const typeUnits = units.filter((u) => u.type === type);
    const isHourly = HOURLY_TYPES.has(type);
    let contracted = 0;
    let potential = 0;
    const unitRows = typeUnits.map((u) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activeAlloc = (u.active_allocations || []).find((a: any) => a.status === "active");
      const monthly = u.monthly_rate ? Number(u.monthly_rate) : 0;
      if (!isHourly) {
        potential += monthly;
        if (activeAlloc) contracted += monthly;
      }
      return {
        unit_id: u.id,
        unit_name: u.name,
        unit_code: u.code,
        monthly_rate: u.monthly_rate ? Number(u.monthly_rate) : null,
        hourly_rate: u.hourly_rate ? Number(u.hourly_rate) : null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contract_number: (activeAlloc as any)?.contract?.contract_number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contract_status: (activeAlloc as any)?.contract?.status,
      };
    });
    return {
      type,
      total_units: typeUnits.length,
      contracted_units: typeUnits.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (u) => (u.active_allocations || []).some((a: any) => a.status === "active")
      ).length,
      monthly_revenue_contracted: contracted,
      monthly_revenue_potential: potential,
      units: unitRows,
    };
  });

  // ── Idle units (active but no active allocation) ──────────────────────────
  const idleUnits = units.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (u) => !(u.active_allocations || []).some((a: any) => a.status === "active")
  );

  const analytics: SpaceAnalytics = {
    floors: floorCUFs,
    overall_cuf: overallCUF,
    occupancy,
    revenue,
    idle_units: idleUnits,
  };

  return NextResponse.json({ data: analytics });
}
