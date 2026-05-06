import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createIrpClient } from "@/lib/e-invoice";
import { loadPublicConfig, loadCredentials } from "@/lib/e-invoice/settings-loader";

/**
 * POST /api/e-invoice/auth-test
 *
 * Admin-only smoke test — performs a fresh authentication round-trip
 * against the configured IRP and returns the resulting token expiry.
 *
 * Used by:
 *   - Settings → E-Invoicing tab "Test Connection" button
 *   - Manual ops verification before production cutover
 *
 * NEVER returns the token, SEK, or credentials in the response.
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

  let publicConfig;
  let credentials;
  try {
    publicConfig = await loadPublicConfig(supabase);
    credentials = await loadCredentials(supabase, publicConfig.environment);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  if (!publicConfig.seller_gstin) {
    return NextResponse.json(
      { ok: false, error: "Seller GSTIN is not configured in Settings → E-Invoicing" },
      { status: 400 }
    );
  }

  let client;
  try {
    client = createIrpClient(
      {
        provider: publicConfig.irp_provider,
        environment: publicConfig.environment,
        gstin: publicConfig.seller_gstin,
        credentials,
      },
      supabase
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const result = await client.authTest();

  // Audit log (without leaking secrets)
  await supabase.from("e_invoice_api_log").insert({
    endpoint: "POST /eivital/v1.04/auth (auth-test)",
    irp_provider: publicConfig.irp_provider,
    environment: publicConfig.environment,
    request_summary: { gstin: publicConfig.seller_gstin, username: credentials.username },
    response_summary: result.ok
      ? { token_expires_at: result.data.token_expires_at }
      : { error_code: result.error.code, error_message: result.error.message },
    irp_status_code: result.ok ? "1" : "0",
    irp_error_code: result.ok ? null : result.error.code,
    irp_error_message: result.ok ? null : result.error.message,
    latency_ms: result.latency_ms,
    attempted_by: dbUser.id,
  });

  if (result.ok) {
    return NextResponse.json({
      ok: true,
      provider: publicConfig.irp_provider,
      environment: publicConfig.environment,
      token_expires_at: result.data.token_expires_at,
      latency_ms: result.latency_ms,
    });
  }
  return NextResponse.json(
    {
      ok: false,
      provider: publicConfig.irp_provider,
      environment: publicConfig.environment,
      error_code: result.error.code,
      error_message: result.error.message,
      latency_ms: result.latency_ms,
    },
    { status: 502 }
  );
}
