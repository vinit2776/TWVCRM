import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const upsertSchema = z.object({
  enabled: z.boolean(),
  service_number: z.string().nullable(),
  landlord_vendor_id: z.string().uuid().nullable(),
  landlord_utility_rate: z.number().min(0),
  landlord_utility_pct: z.number().min(0).max(100),
  landlord_generator_pct: z.number().min(0).max(100),
  landlord_generator_rate: z.number().min(0),
  bill_due_day_of_month: z.number().int().min(1).max(28),
  landlord_gst_applicable: z.boolean(),
  landlord_gst_rate: z.number().min(0).nullable(),
  tds_section: z.string().nullable(),
  tds_rate: z.number().min(0).nullable(),
  onegrid_enabled: z.boolean().optional().default(false),
  onegrid_api_key: z.string().nullable().optional(),
}).refine(
  (d) => Math.abs(d.landlord_utility_pct + d.landlord_generator_pct - 100) < 0.01,
  { message: "Landlord split percentages must sum to 100", path: ["landlord_generator_pct"] }
);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: config, error } = await supabase
    .from("location_electricity_config")
    .select("*")
    .eq("location_id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Fetch allocation summary: sum of ratios per contract mapped to this location
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: contractConfigs } = await (supabase as any)
    .from("contract_electricity_config")
    .select(`
      utility_ratio, generator_ratio, enabled, contract_id,
      contracts(contract_number, status, leads!contracts_lead_id_fkey(first_name, last_name, company))
    `)
    .eq("location_id", id)
    .eq("enabled", true);

  interface ContractConfigRow {
    utility_ratio: number | null;
    generator_ratio: number | null;
    enabled: boolean;
    contract_id: string;
    contracts: {
      contract_number: string;
      status: string;
      leads: { first_name: string; last_name: string; company: string | null } | null;
    } | null;
  }

  const enabledConfigs = ((contractConfigs ?? []) as ContractConfigRow[]).filter(
    (c) => c.enabled && ["active", "renewal_in_progress"].includes(c.contracts?.status ?? "")
  );

  const utilityAllocated = enabledConfigs.reduce((s, c) => s + (c.utility_ratio ?? 0), 0);
  const generatorAllocated = enabledConfigs.reduce((s, c) => s + (c.generator_ratio ?? 0), 0);

  const mappedContracts = enabledConfigs.map((c) => {
    const lead = c.contracts?.leads ?? null;
    const customerName = lead
      ? lead.company || `${lead.first_name} ${lead.last_name}`.trim()
      : "—";
    return {
      contract_id: c.contract_id,
      contract_number: c.contracts?.contract_number ?? "—",
      customer_name: customerName,
    };
  });

  return NextResponse.json({
    data: config,
    allocation: {
      utility_allocated: utilityAllocated,
      generator_allocated: generatorAllocated,
      contract_count: enabledConfigs.length,
    },
    mapped_contracts: mappedContracts,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager role required" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("location_electricity_config")
    .select("*")
    .eq("location_id", id)
    .maybeSingle();

  const { data, error } = await supabase
    .from("location_electricity_config")
    .upsert({ location_id: id, ...parsed.data }, { onConflict: "location_id" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const redact = (k: string, v: unknown) => (k === "onegrid_api_key" ? (v ? "[set]" : null) : v);

  await logAudit(supabase, {
    entityType: "location_electricity_config",
    entityId: data.id,
    action: existing ? "update" : "create",
    performedBy: dbUser.id,
    changes: existing
      ? Object.fromEntries(
          Object.entries(parsed.data)
            .filter(([k, v]) => (existing as Record<string, unknown>)[k] !== v)
            .map(([k, v]) => [k, { old: redact(k, (existing as Record<string, unknown>)[k]), new: redact(k, v) }])
        )
      : { location_id: { old: null, new: id } },
  });

  return NextResponse.json({ data });
}
