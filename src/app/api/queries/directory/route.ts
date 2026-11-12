import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef } from "@/lib/queries/registry";
import { isReadOnlyRole } from "@/lib/queries/audience";
import { requireQueryUser } from "@/lib/queries/server";

/**
 * GET /api/queries/directory?entity_type=billing_statement
 *
 * The people who can be named in the audience picker for a given entity
 * type: active users whose role is authorized on that entity and isn't
 * read-only.
 *
 * A dedicated endpoint rather than reusing /api/users because that one is
 * RLS-scoped (so it returns different things to a sales_rep than to an
 * admin), returns inactive users, and knows nothing about which roles are
 * relevant here. Reads through the admin client behind an explicit role
 * check, and returns id/name/role only — nothing a caller couldn't already
 * see on any thread they open.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const auth = await requireQueryUser(supabase);
  if ("error" in auth) return auth.error;

  const entityType = new URL(req.url).searchParams.get("entity_type") ?? "";
  const def = queryEntityDef(entityType);
  if (!def) return NextResponse.json({ error: "Unknown entity type" }, { status: 400 });
  if (!(def.roles as readonly string[]).includes(auth.dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const askableRoles = def.roles.filter((r) => !isReadOnlyRole(r));

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("id, full_name, role")
    .eq("is_active", true)
    .in("role", askableRoles)
    .order("full_name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ users: data ?? [] });
}
