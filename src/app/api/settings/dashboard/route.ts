import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  DASHBOARD_ROLE_WIDGETS,
  WIDGET_REGISTRY,
  type WidgetId,
} from "@/lib/dashboard-config";
import type { UserRole } from "@/types";
import { USER_ROLES } from "@/lib/constants";

const SETTINGS_KEY = "dashboard_role_widgets";

// GET — fetch widget list for a role (any authenticated user)
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = request.nextUrl.searchParams.get("role") as UserRole | null;

  // If a specific role is requested, return just that role's widgets
  if (role) {
    if (!USER_ROLES.includes(role as (typeof USER_ROLES)[number])) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", SETTINGS_KEY)
      .maybeSingle();

    if (data?.value) {
      try {
        const config = JSON.parse(data.value);
        if (config[role] && Array.isArray(config[role])) {
          return NextResponse.json(config[role]);
        }
      } catch {
        /* fall through to defaults */
      }
    }

    return NextResponse.json(DASHBOARD_ROLE_WIDGETS[role]);
  }

  // No role specified — return full config (for admin settings UI)
  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();

  let config: Record<string, WidgetId[]> = { ...DASHBOARD_ROLE_WIDGETS };
  if (data?.value) {
    try {
      const saved = JSON.parse(data.value);
      // Merge saved config over defaults (so new roles get defaults)
      config = { ...DASHBOARD_ROLE_WIDGETS, ...saved };
    } catch {
      /* use defaults */
    }
  }

  return NextResponse.json(config);
}

// PATCH — update widget config for a role (admin only)
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { role, widgets } = body as { role: string; widgets: string[] };

  // Validate role
  if (!role || !USER_ROLES.includes(role as (typeof USER_ROLES)[number])) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  // Validate widget IDs
  const validWidgetIds = Object.keys(WIDGET_REGISTRY);
  if (!Array.isArray(widgets) || !widgets.every((w) => validWidgetIds.includes(w))) {
    return NextResponse.json({ error: "Invalid widget IDs" }, { status: 400 });
  }

  // Read existing config
  const { data: existing } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();

  let config: Record<string, string[]> = {};
  if (existing?.value) {
    try {
      config = JSON.parse(existing.value);
    } catch {
      /* start fresh */
    }
  }

  const oldWidgets = config[role] || DASHBOARD_ROLE_WIDGETS[role as UserRole] || [];
  config[role] = widgets;

  // Upsert
  const { error } = await supabase.from("app_settings").upsert(
    {
      key: SETTINGS_KEY,
      value: JSON.stringify(config),
      updated_by: dbUser.id,
    },
    { onConflict: "key" }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "app_setting",
    entityId: SETTINGS_KEY,
    action: "update",
    performedBy: dbUser.id,
    changes: { [role]: { old: oldWidgets, new: widgets } },
  });

  return NextResponse.json({ message: "Dashboard config updated" });
}
