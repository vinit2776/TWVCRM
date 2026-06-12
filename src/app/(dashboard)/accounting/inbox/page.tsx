import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Inbox } from "lucide-react";

const ALLOWED_ROLES = ["accounts", "admin", "office_admin", "manager"] as const;

export const dynamic = "force-dynamic";

export default async function TallyInboxPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .maybeSingle();

  const role = profile?.role as string | undefined;
  if (!role || !ALLOWED_ROLES.includes(role as typeof ALLOWED_ROLES[number])) {
    redirect("/dashboard");
  }

  const { data: flagRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "tally_handoff_v2_enabled")
    .maybeSingle();

  const flagEnabled = flagRow?.value === "true";

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <div className="flex items-center gap-3 mb-2">
        <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
        <h1 className="text-2xl font-semibold">Tally Inbox</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Worklist for the Tally handoff flow. Accounts uploads GST invoices,
        records receipts, and resolves discrepancies here.
      </p>

      {!flagEnabled ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium mb-1">Tally handoff v2 is not enabled.</p>
          <p>
            An admin can enable it via Admin → Settings →{" "}
            <code className="font-mono text-xs bg-amber-100 px-1 py-0.5 rounded">
              tally_handoff_v2_enabled
            </code>
            . Until then this page is a placeholder.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          <p>
            Worklist UI lands in the next PR. This page is currently a stub —
            routing, role gating, and the feature flag are wired and working.
          </p>
        </div>
      )}
    </div>
  );
}
