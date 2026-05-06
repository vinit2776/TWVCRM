/**
 * Reads e-invoice configuration + credentials from app_settings.
 *
 * - Public config (IRP provider, environment, GSTIN, seller details, default
 *   SAC code, go-live date, etc.) is plaintext.
 * - Credentials (username, password, client_id, client_secret) are stored
 *   encrypted-at-rest using EINVOICE_SECRETS_KEY env var.
 *
 * One-time bootstrap: if the encrypted credential rows are empty AND fallback
 * env vars (EINVOICE_BOOTSTRAP_*) are set, we auto-populate the encrypted
 * rows on first read. This is for dev convenience — production credentials
 * always come from the Settings UI (Phase 4).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptAtRest, encryptAtRest } from "./token-cache";
import type { IrpProvider, IrpEnvironment, IrpCredentials } from "./irp-client";

export interface EInvoicePublicConfig {
  enabled: boolean;
  environment: IrpEnvironment;
  irp_provider: IrpProvider;
  seller_gstin: string;
  seller_legal_name: string;
  seller_trade_name?: string;
  seller_address1: string;
  seller_address2?: string;
  seller_location: string;
  seller_pincode: string;
  seller_state_code: string;
  default_sac_code: string;
  default_gst_rate: number;
  go_live_date: string;
  daily_batch_enabled: boolean;
  daily_batch_hour_ist: number;
}

const PUBLIC_KEYS = [
  "einvoice_enabled",
  "einvoice_environment",
  "einvoice_irp_provider",
  "einvoice_seller_gstin",
  "einvoice_seller_legal_name",
  "einvoice_seller_trade_name",
  "einvoice_seller_address1",
  "einvoice_seller_address2",
  "einvoice_seller_location",
  "einvoice_seller_pincode",
  "einvoice_seller_state_code",
  "einvoice_default_sac_code",
  "einvoice_default_gst_rate",
  "einvoice_go_live_date",
  "einvoice_daily_batch_enabled",
  "einvoice_daily_batch_hour_ist",
] as const;

/** Read the public configuration block. Throws if app_settings rows are missing. */
export async function loadPublicConfig(supabase: SupabaseClient): Promise<EInvoicePublicConfig> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", PUBLIC_KEYS as unknown as string[]);
  if (error) throw new Error(`Failed to read e-invoice settings: ${error.message}`);

  const map = new Map<string, string>((data ?? []).map((r) => [r.key, r.value]));
  const get = (k: string) => map.get(k) ?? "";

  return {
    enabled: get("einvoice_enabled") === "true",
    environment: (get("einvoice_environment") || "sandbox") as IrpEnvironment,
    irp_provider: (get("einvoice_irp_provider") || "einvoice6") as IrpProvider,
    seller_gstin: get("einvoice_seller_gstin"),
    seller_legal_name: get("einvoice_seller_legal_name"),
    seller_trade_name: get("einvoice_seller_trade_name") || undefined,
    seller_address1: get("einvoice_seller_address1"),
    seller_address2: get("einvoice_seller_address2") || undefined,
    seller_location: get("einvoice_seller_location"),
    seller_pincode: get("einvoice_seller_pincode"),
    seller_state_code: get("einvoice_seller_state_code") || "33",
    default_sac_code: get("einvoice_default_sac_code") || "997212",
    default_gst_rate: parseFloat(get("einvoice_default_gst_rate") || "18"),
    go_live_date: get("einvoice_go_live_date") || "2026-05-15",
    daily_batch_enabled: get("einvoice_daily_batch_enabled") === "true",
    daily_batch_hour_ist: parseInt(get("einvoice_daily_batch_hour_ist") || "23", 10),
  };
}

/**
 * Read the active environment's credentials, decrypting from app_settings.
 *
 * Bootstrap: if the encrypted credentials are empty and EINVOICE_BOOTSTRAP_*
 * env vars are set, we lazily populate the encrypted rows. This lets us
 * test locally with credentials in .env.local without exposing them in git.
 */
export async function loadCredentials(
  supabase: SupabaseClient,
  environment: IrpEnvironment,
): Promise<IrpCredentials> {
  const prefix = environment === "sandbox" ? "einvoice_sandbox" : "einvoice_production";
  const keys = [
    `${prefix}_username`,
    `${prefix}_password`,
    `${prefix}_client_id`,
    `${prefix}_client_secret`,
  ];

  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", keys);
  if (error) throw new Error(`Failed to read e-invoice credentials: ${error.message}`);

  const map = new Map<string, string>((data ?? []).map((r) => [r.key, r.value]));

  // Helper: decrypt or null
  const dec = (k: string): string | null => {
    const v = map.get(k);
    if (!v) return null;
    try { return decryptAtRest(v); } catch { return null; }
  };

  let username = dec(`${prefix}_username`);
  let password = dec(`${prefix}_password`);
  let client_id = dec(`${prefix}_client_id`);
  let client_secret = dec(`${prefix}_client_secret`);

  // Bootstrap from env if any field is missing AND env vars are set
  if (!username || !password || !client_id || !client_secret) {
    const envPrefix = environment === "sandbox" ? "EINVOICE_BOOTSTRAP_SANDBOX" : "EINVOICE_BOOTSTRAP_PRODUCTION";
    const envU = process.env[`${envPrefix}_USERNAME`];
    const envP = process.env[`${envPrefix}_PASSWORD`];
    const envCi = process.env[`${envPrefix}_CLIENT_ID`];
    const envCs = process.env[`${envPrefix}_CLIENT_SECRET`];

    if (envU && envP && envCi && envCs) {
      const upserts = [
        { key: `${prefix}_username`, value: encryptAtRest(envU), is_encrypted: true },
        { key: `${prefix}_password`, value: encryptAtRest(envP), is_encrypted: true },
        { key: `${prefix}_client_id`, value: encryptAtRest(envCi), is_encrypted: true },
        { key: `${prefix}_client_secret`, value: encryptAtRest(envCs), is_encrypted: true },
      ];
      for (const row of upserts) {
        await supabase.from("app_settings").upsert(row, { onConflict: "key" });
      }
      username = envU; password = envP; client_id = envCi; client_secret = envCs;
    }
  }

  if (!username || !password || !client_id || !client_secret) {
    throw new Error(
      `${environment} credentials are not configured. ` +
      `Set them via Settings → E-Invoicing tab, or via EINVOICE_BOOTSTRAP_${environment.toUpperCase()}_* env vars.`
    );
  }

  return { username, password, client_id, client_secret };
}
