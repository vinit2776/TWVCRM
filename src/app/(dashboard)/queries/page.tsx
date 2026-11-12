import { redirect } from "next/navigation";
import { MessageCircleQuestion } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isQueryUser } from "@/lib/queries/registry";
import { QUERY_ACCENT_TEXT } from "@/lib/queries/theme";
import { QueriesClient } from "@/components/queries/queries-client";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

/**
 * /queries — the unified clarification inbox.
 *
 * Replaces /billing-queries, which now redirects here (preserving ?open= so
 * links inside already-delivered notifications keep working).
 */
export const dynamic = "force-dynamic";

export default async function QueriesPage({
  searchParams,
}: {
  searchParams: Promise<{ open?: string }>;
}) {
  const { open } = await searchParams;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!isQueryUser(profile?.role)) redirect("/dashboard");

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <PageBreadcrumb resetTo={{ label: "Queries" }} />
      <div className="flex items-center gap-3 mb-2">
        <MessageCircleQuestion className={`h-6 w-6 ${QUERY_ACCENT_TEXT}`} aria-hidden />
        <h1 className="text-2xl font-semibold">Queries</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Clarifications raised on specific transactions — answer them here, from wherever you are.
      </p>

      <QueriesClient openQueryId={open} />
    </div>
  );
}
