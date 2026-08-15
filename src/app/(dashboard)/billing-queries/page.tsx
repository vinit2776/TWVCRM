import { redirect } from "next/navigation";

/**
 * Billing Queries moved to /queries when the feature was generalised beyond
 * billing statements (see supabase/migrations/00420_generalise_queries.sql).
 *
 * This redirect is NOT optional and shouldn't be deleted on a cleanup pass:
 * notification rows already delivered to users carry
 * `url: '/billing-queries?open=<id>'`, and the in-app bell renders whatever
 * URL is stored on the row. Dropping the ?open= param would land people on
 * the list with no idea which thread they were called about.
 */
export const dynamic = "force-dynamic";

export default async function BillingQueriesRedirect({
  searchParams,
}: {
  searchParams: Promise<{ open?: string }>;
}) {
  const { open } = await searchParams;
  redirect(open ? `/queries?open=${encodeURIComponent(open)}` : "/queries");
}
