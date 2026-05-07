import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createIrpClient } from "@/lib/e-invoice";
import { loadPublicConfig, loadCredentials } from "@/lib/e-invoice/settings-loader";

/**
 * POST /api/e-invoice/sync-seller-gstin
 *
 * Fetches the seller's own GSTIN details from the IRP's Master API and
 * auto-populates legal name, trade name, address fields in app_settings.
 *
 * Used by the "Sync from IRP" button on the E-Invoicing settings tab —
 * saves the operator from typing addresses that the GSTN already knows.
 *
 * IRP endpoint: GET /eivital/v1.04/Master/gstin/{gstin}
 * Response: { Status, Data (encrypted) → { LglNm, TrdNm, Adr1, Adr2, Loc, Pncd, Stcd, ... } }
 */
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const config = await loadPublicConfig(supabase);
  if (!config.seller_gstin) {
    return NextResponse.json({ error: "Set seller GSTIN first" }, { status: 400 });
  }

  let credentials;
  try {
    credentials = await loadCredentials(supabase, config.environment);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Credentials missing" },
      { status: 400 }
    );
  }

  const client = createIrpClient(
    {
      provider: config.irp_provider,
      environment: config.environment,
      gstin: config.seller_gstin,
      credentials,
    },
    supabase
  );

  const result = await client.getGstinDetails(config.seller_gstin);

  await supabase.from("e_invoice_api_log").insert({
    endpoint: `GET /eivital/v1.04/Master/gstin/${config.seller_gstin}`,
    irp_provider: config.irp_provider,
    environment: config.environment,
    request_summary: { gstin: config.seller_gstin },
    response_summary: result.ok ? { synced: true } : { error: result.error },
    irp_status_code: result.ok ? "1" : "0",
    irp_error_code: result.ok ? null : result.error?.code,
    irp_error_message: result.ok ? null : result.error?.message,
    latency_ms: result.latency_ms,
    attempted_by: dbUser.id,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error?.message || "GSTIN lookup failed", code: result.error?.code },
      { status: 502 }
    );
  }

  // Map IRP fields to our app_settings keys
  const d = result.data;

  const updates: { key: string; value: string }[] = [];
  if (d.LglNm) updates.push({ key: "einvoice_seller_legal_name", value: d.LglNm });
  if (d.TrdNm) updates.push({ key: "einvoice_seller_trade_name", value: d.TrdNm });
  if (d.Adr1)  updates.push({ key: "einvoice_seller_address1", value: d.Adr1 });
  if (d.Adr2)  updates.push({ key: "einvoice_seller_address2", value: d.Adr2 });
  if (d.Loc)   updates.push({ key: "einvoice_seller_location", value: d.Loc });
  if (d.Pncd)  updates.push({ key: "einvoice_seller_pincode", value: String(d.Pncd) });
  if (d.Stcd)  updates.push({ key: "einvoice_seller_state_code", value: d.Stcd });

  for (const u of updates) {
    await supabase.from("app_settings").update({ value: u.value }).eq("key", u.key);
  }

  return NextResponse.json({ ok: true, fields_synced: updates.length, fields: updates.map((u) => u.key) });
}
