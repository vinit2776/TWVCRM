import type { SupabaseClient } from "@supabase/supabase-js";
import { nocReference } from "@/lib/noc/rules";

/** Everything about one NOC order that the staff screens, the public page and the emails all need, read once. */
export interface NocBundle {
  noc: {
    id: string; noc_number: string; sequence_in_contract: number; contract_id: string; lead_id: string | null; purpose: "roc" | "gst";
    location_id: string; company_name: string; cin: string | null; gstin: string | null; noc_address: string; fee_excl_gst: number; tax_percentage: number;
    status: "draft" | "sent" | "accepted" | "paid" | "issued" | "void"; public_token: string; invoice_id: string | null; billing_statement_id: string | null;
    sent_at: string | null; sent_to: string | null; accepted_at: string | null; accepted_by_name: string | null; accepted_by_designation: string | null;
    accepted_text_hash: string | null; accepted_ip: string | null; accepted_user_agent: string | null; acceptance_document_id: string | null;
    razorpay_link_id: string | null; razorpay_link_url: string | null; paid_at: string | null; payment_reference: string | null; created_at: string;
  };
  reference: string;
  centreName: string;
  contract: { contract_number: string; agreement_date: string | null; created_at: string | null; end_date: string; tenure_months: number | null; member_signatory_name: string | null; status: string };
  lead: { first_name: string | null; last_name: string | null; company: string | null; email: string | null; phone: string | null; mobile: string | null } | null;
  total: number;
  fee: { excl: number; tax: number; total: number };
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

export async function loadNocBundle(admin: SupabaseClient, by: { id: string } | { token: string }): Promise<NocBundle | null> {
  const q = admin.from("noc_requests").select("*, location:locations!noc_requests_location_id_fkey(name)");
  const { data: noc } = await ("id" in by ? q.eq("id", by.id) : q.eq("public_token", by.token)).maybeSingle();
  if (!noc) return null;
  const { data: contract } = await admin
    .from("contracts")
    .select("contract_number, agreement_date, created_at, end_date, tenure_months, member_signatory_name, status, lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email, phone, mobile)")
    .eq("id", noc.contract_id)
    .single();
  if (!contract) return null;
  const tax = Math.round(Number(noc.fee_excl_gst) * Number(noc.tax_percentage)) / 100;
  const { location, ...row } = noc as typeof noc & { location: { name: string } | { name: string }[] | null };
  const { lead, ...c } = contract as typeof contract & { lead: NocBundle["lead"] | NocBundle["lead"][] | null };
  return {
    noc: row as NocBundle["noc"],
    reference: nocReference(c.contract_number, noc.sequence_in_contract),
    centreName: one(location)?.name ?? "",
    contract: c as NocBundle["contract"],
    lead: one(lead),
    total: Math.round((Number(noc.fee_excl_gst) + tax) * 100) / 100,
    fee: { excl: Number(noc.fee_excl_gst), tax, total: Math.round((Number(noc.fee_excl_gst) + tax) * 100) / 100 },
  };
}

export const leadDisplayName = (l: NocBundle["lead"]) => (l ? (`${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() || l.company || "Customer") : "Customer");
