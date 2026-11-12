/**
 * POST /api/facility/assets/[id]/credentials/reveal
 *
 * Decrypts and returns the stored admin password for one asset. Mirrors
 * /api/unifi/vouchers/reveal's shape (role-gated here since a device admin
 * password is more sensitive than a WiFi guest voucher) — both a successful
 * reveal and a role-denied attempt are written to the audit trail.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";
import { decryptSecret } from "@/lib/crypto-secrets";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });
  if (!hasRole(dbUser.role, FACILITY_ROLES.credentials)) {
    // A refused attempt on a password store is worth more to whoever reads
    // this trail later than a successful one, so it gets its own entry.
    void logAudit(createAdminClient(), {
      entityType: "facility_asset_credentials", entityId: id, action: "view",
      performedBy: dbUser.id,
      changes: {
        password_revealed: { old: null, new: "DENIED" },
        revealed_by_role: { old: null, new: dbUser.role },
      },
    });
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  const { data: creds, error } = await supabase
    .from("facility_asset_credentials")
    .select("password_encrypted")
    .eq("asset_id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!creds) return NextResponse.json({ error: "No credentials on file for this asset" }, { status: 404 });

  let password: string;
  try {
    password = decryptSecret(creds.password_encrypted);
  } catch (err) {
    console.error("[api/facility/assets/credentials/reveal] decrypt failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to decrypt stored password" }, { status: 500 });
  }

  // Use the admin client so the audit write never depends on the caller's
  // own RLS grants — matches the unifi voucher reveal route.
  const admin = createAdminClient();
  void logAudit(admin, {
    entityType: "facility_asset_credentials", entityId: id, action: "view",
    performedBy: dbUser.id,
    changes: {
      password_revealed: { old: null, new: "ACCESSED" },
      revealed_by_role: { old: null, new: dbUser.role },
    },
  });

  return NextResponse.json({ password });
}
