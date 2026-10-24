import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { summariseSetup } from "@/lib/electricity-setup-checks";
import { loadSetupChecks } from "@/lib/electricity-setup-server";

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

  try {
    const checks = await loadSetupChecks(createAdminClient(), id);
    return NextResponse.json({ data: { checks, summary: summariseSetup(checks) } });
  } catch (err) {
    console.error("[electricity-setup] read failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Could not read the electricity setup" }, { status: 500 });
  }
}
