import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";
import { encryptSecret } from "@/lib/crypto-secrets";

// GET — non-secret fields only (admin_url, username, updated_at). Any
// authenticated user who can see the asset can see that credentials exist
// and what the URL/username are; the password itself only comes back from
// POST .../credentials/reveal.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("facility_asset_credentials")
    .select("id, admin_url, username, updated_at")
    .eq("asset_id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

// PUT — create or update. `password` is optional on update (omit it to keep
// the existing one unchanged); required the first time credentials are added
// for an asset.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.credentials)) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  const body = await request.json();
  const adminUrl = typeof body.admin_url === "string" ? body.admin_url.trim() || null : null;
  const username = typeof body.username === "string" ? body.username.trim() || null : null;
  const password = typeof body.password === "string" && body.password.length > 0 ? body.password : undefined;

  const { data: existing } = await supabase
    .from("facility_asset_credentials")
    .select("id, admin_url, username, password_encrypted")
    .eq("asset_id", id)
    .maybeSingle();

  if (!existing && password === undefined) {
    return NextResponse.json(
      { error: "Password is required when adding credentials for the first time" },
      { status: 400 }
    );
  }

  let encryptedPassword: string;
  try {
    encryptedPassword = password !== undefined ? encryptSecret(password) : existing!.password_encrypted;
  } catch (err) {
    console.error("[api/facility/assets/credentials] encrypt failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to encrypt password" }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("facility_asset_credentials")
    .upsert(
      { asset_id: id, admin_url: adminUrl, username, password_encrypted: encryptedPassword, updated_by: dbUser!.id },
      { onConflict: "asset_id" }
    )
    .select("id, admin_url, username, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_asset_credentials", entityId: id,
    action: existing ? "update" : "create",
    performedBy: dbUser!.id,
    changes: {
      admin_url: { old: existing?.admin_url ?? null, new: adminUrl },
      username: { old: existing?.username ?? null, new: username },
      password_changed: { old: null, new: password !== undefined },
    },
  });

  return NextResponse.json({ data });
}

// DELETE — clear stored credentials for this asset entirely (e.g. device was
// replaced, or they were entered against the wrong asset by mistake).
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.credentials)) {
    return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
  }

  const { error } = await supabase
    .from("facility_asset_credentials")
    .delete()
    .eq("asset_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "facility_asset_credentials", entityId: id,
    action: "delete", performedBy: dbUser!.id,
  });

  return NextResponse.json({ success: true });
}
