import { createAdminClient } from "@/lib/supabase/server";

/**
 * Is the KYC waiver feature actually usable against this database?
 *
 * Vercel deploys the moment a PR merges, but a migration is applied by hand.
 * Between those two events the waive UI exists and every click fails on a
 * missing column. This probe closes that window: the buttons stay hidden until
 * 00535 has landed, then appear on their own without a redeploy.
 *
 * Postgres reports an unknown column as 42703, which is the one error that
 * means "not migrated yet". Anything else — a network blip, a permission
 * problem — is not evidence either way, so it is treated as unavailable but
 * not cached, and the next call retries.
 */
let cached: { value: boolean; at: number } | null = null;

/** Once true it cannot become false again, so that answer is kept for good. */
const NEGATIVE_TTL_MS = 60_000;

export async function waiverColumnsPresent(): Promise<boolean> {
  if (cached?.value) return true;
  if (cached && Date.now() - cached.at < NEGATIVE_TTL_MS) return false;

  try {
    const supabase = await createAdminClient();
    const { error } = await supabase
      .from("contract_documents")
      .select("waived_at")
      .limit(1);

    if (!error) {
      cached = { value: true, at: Date.now() };
      return true;
    }

    if (error.code === "42703") {
      cached = { value: false, at: Date.now() };
      return false;
    }

    console.error("[kyc-waiver] probe failed:", error.message);
    return false;
  } catch (err) {
    console.error("[kyc-waiver] probe threw:", err);
    return false;
  }
}
