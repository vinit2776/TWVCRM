/**
 * Reads an env var and strips surrounding whitespace.
 *
 * Vercel stores whatever was pasted into its dashboard, trailing newline
 * included, and a stray "\n" is invisible in the UI. This has bitten this
 * codebase twice:
 *
 *   • MSG91_WHATSAPP_SENDER — every outbound WhatsApp call failed with
 *     "WhatsApp not integrated: 917200001638\n" (see envStr in
 *     src/lib/whatsapp.ts, which predates this helper).
 *   • BACKUP_DB_HOST — the nightly database backup died with
 *     "getaddrinfo ENOTFOUND aws-1-ap-south-1.pooler.supabase.com\n" and,
 *     because the health ping was also broken, went unnoticed for four months.
 *
 * Use this for any env var that becomes a hostname, URL, or is compared as an
 * exact string. Returns undefined for unset or whitespace-only values so that
 * `?? fallback` behaves as expected.
 */
export function envStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Like envStr, but throws when the value is missing — for hard requirements. */
export function envStrRequired(name: string): string {
  const value = envStr(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
