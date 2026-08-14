import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MessageCircleQuestion } from "lucide-react";
import { isBillingQueryRole } from "@/lib/billing-queries";
import { BillingQueriesClient } from "@/components/billing/billing-queries-client";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

export const dynamic = "force-dynamic";

export default async function BillingQueriesPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!isBillingQueryRole(profile?.role)) {
    redirect("/dashboard");
  }

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <PageBreadcrumb resetTo={{ label: "Billing Queries" }} />
      <div className="flex items-center gap-3 mb-2">
        <MessageCircleQuestion className="h-6 w-6 text-muted-foreground" aria-hidden />
        <h1 className="text-2xl font-semibold">Billing Queries</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Questions Accounts has raised on specific statements — respond here, from wherever you are.
      </p>

      <BillingQueriesClient currentUserRole={profile?.role ?? ""} />
    </div>
  );
}
