import { redirect } from "next/navigation";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { Inbox } from "lucide-react";
import { isInboxRole } from "@/lib/tally-handoff";
import { InboxTabs } from "@/components/accounting/inbox-tabs";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

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

  if (!isInboxRole(profile?.role)) {
    redirect("/dashboard");
  }

  const admin = createAdminClient();
  const { data: flagRow } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "tally_handoff_v2_enabled")
    .maybeSingle();

  const flagEnabled = flagRow?.value === "true";

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <PageBreadcrumb resetTo={{ label: "Tally Inbox" }} />
      <div className="flex items-center gap-3 mb-2">
        <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
        <h1 className="text-2xl font-semibold">Tally Inbox</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Worklist for the Tally handoff flow. Accounts uploads GST invoices,
        records receipts, and resolves discrepancies here.
      </p>

      <InboxTabs flagEnabled={flagEnabled} currentUserRole={profile?.role || ""} />
    </div>
  );
}
