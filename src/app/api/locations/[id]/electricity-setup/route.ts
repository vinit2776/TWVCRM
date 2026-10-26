import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { computeSetupChecks, summariseSetup, type SetupContract } from "@/lib/electricity-setup-checks";

/**
 * GET /api/locations/[id]/electricity-setup
 *
 * Read-only: what is and isn't set up at this location for electricity billing. Reads config, connections,
 * contract settings and billing profiles; changes and sends nothing.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const [configRes, connectionsRes, contractsRes, settingRes] = await Promise.all([
    admin
      .from("location_electricity_config")
      .select("enabled, landlord_vendor_id, landlord_utility_pct, landlord_generator_pct")
      .eq("location_id", id)
      .maybeSingle(),
    admin
      .from("location_electricity_connections")
      .select("id", { count: "exact", head: true })
      .eq("location_id", id)
      .eq("is_active", true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (admin as any)
      .from("contract_electricity_config")
      .select("contract_id, enabled, billing_profile_id, contracts(contract_number, status)")
      .eq("location_id", id),
    admin.from("app_settings").select("value").eq("key", "electricity_auto_approve_enabled").maybeSingle(),
  ]);

  for (const r of [configRes, connectionsRes, contractsRes]) {
    if (r.error) {
      console.error("[electricity-setup] read failed:", r.error.message);
      return NextResponse.json({ error: "Could not read the electricity setup" }, { status: 500 });
    }
  }

  const config = configRes.data;

  let landlordVendorName: string | null = null;
  if (config?.landlord_vendor_id) {
    const { data: vendor } = await admin
      .from("procurement_vendors")
      .select("name")
      .eq("id", config.landlord_vendor_id)
      .maybeSingle();
    landlordVendorName = vendor?.name ?? null;
  }

  interface ContractRow {
    contract_id: string;
    enabled: boolean;
    billing_profile_id: string | null;
    contracts: { contract_number: string; status: string } | null;
  }
  const rows = (contractsRes.data ?? []) as ContractRow[];

  const profileIds = [...new Set(rows.map((r) => r.billing_profile_id).filter((p): p is string => !!p))];
  const activeProfiles = new Set<string>();
  if (profileIds.length > 0) {
    const { data: profiles } = await admin
      .from("electricity_billing_profiles")
      .select("id, is_active")
      .in("id", profileIds);
    for (const p of profiles ?? []) if (p.is_active) activeProfiles.add(p.id as string);
  }

  const contracts: SetupContract[] = rows.map((r) => ({
    contract_id: r.contract_id,
    contract_number: r.contracts?.contract_number ?? "—",
    enabled: r.enabled,
    status: r.contracts?.status ?? "",
    billing_profile_id: r.billing_profile_id,
    profile_active: !!r.billing_profile_id && activeProfiles.has(r.billing_profile_id),
  }));

  const checks = computeSetupChecks({
    config: config
      ? {
          enabled: !!config.enabled,
          landlord_vendor_id: config.landlord_vendor_id,
          landlord_utility_pct: Number(config.landlord_utility_pct),
          landlord_generator_pct: Number(config.landlord_generator_pct),
        }
      : null,
    landlordVendorName,
    activeConnections: connectionsRes.count ?? 0,
    contracts,
    // A missing row means on, same as the capture route.
    autoApproveEnabled: settingRes.data?.value !== "false",
  });

  return NextResponse.json({ data: { checks, summary: summariseSetup(checks) } });
}
