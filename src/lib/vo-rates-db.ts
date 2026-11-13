/**
 * Deploys land before migrations are applied by hand, so the VO rate tables may not
 * exist yet. Postgres reports that as 42P01; PostgREST as PGRST205 (schema cache miss).
 */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /relation .* does not exist/i.test(error.message ?? "");
}

export const RATES_NOT_SET_UP = "Rate cards are not set up yet. Apply the VO rate card migrations first.";
