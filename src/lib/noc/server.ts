import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomInt } from "crypto";
import { isRealProduction } from "@/lib/noc/safe-send";
import { buildNocLetter, type NocLetterInput, type NocPurpose } from "@/lib/noc/rules";

export interface NocSettings {
  enabled: boolean;
  feeRoc: number;
  feeGst: number;
  taxPercentage: number;
  signatoryName: string;
  signatoryDesignation: string;
}

/** Read straight from the table (not the 5-minute cache) so switching the feature on or off takes effect at once. */
export async function loadNocSettings(admin: SupabaseClient): Promise<NocSettings> {
  const { data } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["noc_service_enabled", "noc_fee_roc", "noc_fee_gst", "noc_tax_percentage", "noc_signatory_name", "noc_signatory_designation"]);
  const m = new Map((data ?? []).map((r: { key: string; value: string | null }) => [r.key, r.value]));
  const num = (k: string, d: number) => { const n = Number(m.get(k)); return Number.isFinite(n) && m.get(k) !== null && m.get(k) !== "" ? n : d; };
  return {
    enabled: m.get("noc_service_enabled") === "true",
    feeRoc: num("noc_fee_roc", 20000),
    feeGst: num("noc_fee_gst", 20000),
    taxPercentage: num("noc_tax_percentage", 18),
    signatoryName: m.get("noc_signatory_name") || "Naval Chordia",
    signatoryDesignation: m.get("noc_signatory_designation") || "Director",
  };
}

/** One append-only audit row. Never throws: a failed log line must not undo the action, but is reported. */
export async function recordNocEvent(
  admin: SupabaseClient,
  nocId: string,
  event: string,
  opts: { actorId?: string | null; actorLabel?: string | null; detail?: Record<string, unknown>; ip?: string | null; userAgent?: string | null } = {},
) {
  const { error } = await admin.from("noc_audit_events").insert({
    noc_id: nocId, event, actor_id: opts.actorId ?? null, actor_label: opts.actorLabel ?? null,
    detail: opts.detail ?? {}, ip: opts.ip ?? null, user_agent: opts.userAgent ?? null,
  });
  if (error) console.error("noc audit event failed", event, error.message);
}

interface NocRow {
  purpose: NocPurpose;
  company_name: string;
  noc_address: string;
  status: string;
}
interface ContractFacts { agreement_date: string | null; created_at: string | null; end_date: string; tenure_months: number | null }

/** The letter for an order, filled from the order and the contract's own dates. */
export function letterFor(noc: NocRow, contract: ContractFacts, s: NocSettings, issueDate?: string | null) {
  const input: NocLetterInput = {
    purpose: noc.purpose,
    companyName: noc.company_name,
    address: noc.noc_address,
    agreementDate: (contract.agreement_date ?? contract.created_at ?? "").toString().slice(0, 10) || null,
    endDate: contract.end_date,
    tenureMonths: contract.tenure_months,
    signatoryName: s.signatoryName,
    signatoryDesignation: s.signatoryDesignation,
    issueDate: issueDate ?? null,
  };
  return buildNocLetter(input);
}

export const clientIp = (h: Headers) => h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;

// ── Crypto helpers (server only) ─────────────────────────────────────────────────────────────────────────────
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const generateOtp = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
/** Codes are stored hashed and tied to the order, so a leaked table row is useless for another order. */
export const hashOtp = (code: string, nocId: string) => sha256(`noc-otp:${nocId}:${code.trim()}`);

/** Where customer-facing links point: the live address in production, otherwise the address the request came in on. */
export function appOrigin(reqUrl: string): string {
  if (isRealProduction()) return (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim().replace(/\/$/, "");
  return new URL(reqUrl).origin;
}
export const customerLink = (origin: string, token: string) => `${origin}/noc/${token}`;
