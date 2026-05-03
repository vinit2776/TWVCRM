import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/contracts/kyc-pending
 *
 * Single source of truth for "what KYC is outstanding right now". Mirrors the
 * data shape used by the weekly Saturday digest cron (/api/cron/kyc-reminder)
 * so the in-app dashboard and the email always agree.
 *
 * Query:
 *   ?contract_status=active|signed|draft|all   (default: active+signed+draft)
 *   ?doc_status=pending|deferred|all           (default: all → both)
 *   ?overdue_only=true                          (only deferred docs past deferred_until)
 *
 * Response shape:
 *   {
 *     summary: { contracts, total_pending, total_deferred, total_overdue },
 *     contracts: [
 *       { id, contract_number, status, customer_name, company, location_name,
 *         email, phone, created_at, docs: [
 *           { id, label, status, deferred_by, deferrer_name, deferred_at,
 *             deferred_reason, deferred_until, is_overdue }
 *         ]
 *       }
 *     ]
 *   }
 */

const DEFAULT_CONTRACT_STATUSES = ["active", "signed", "pending_activation", "draft"];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const contractStatusParam = searchParams.get("contract_status");
  const docStatusParam = searchParams.get("doc_status");
  const overdueOnly = searchParams.get("overdue_only") === "true";

  const contractStatuses = contractStatusParam && contractStatusParam !== "all"
    ? contractStatusParam.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CONTRACT_STATUSES;

  const docStatuses = docStatusParam && docStatusParam !== "all"
    ? docStatusParam.split(",").map((s) => s.trim()).filter(Boolean)
    : ["pending", "deferred"];

  const { data: rows, error } = await supabase
    .from("contract_documents")
    .select(`
      id, label, status,
      deferred_at, deferred_reason, deferred_until,
      deferrer:users!contract_documents_deferred_by_fkey(id, full_name),
      contract:contracts!contract_documents_contract_id_fkey(
        id, contract_number, status, created_at,
        lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email, phone, mobile),
        location:locations!contracts_location_id_fkey(id, name, code)
      )
    `)
    .eq("is_required", true)
    .in("status", docStatuses)
    .order("contract_id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const today = new Date().toISOString().slice(0, 10);

  // Group by contract; filter by contract_status + overdue_only at JS layer
  // (cleaner than nested filter on the relational select).
  type ContractRel = {
    id: string;
    contract_number: string;
    status: string;
    created_at: string;
    lead: { first_name?: string; last_name?: string; company?: string; email?: string; phone?: string; mobile?: string } | null;
    location: { id: string; name: string; code: string } | null;
  };
  type DocRow = {
    id: string;
    label: string;
    status: "pending" | "deferred";
    deferred_at: string | null;
    deferred_reason: string | null;
    deferred_until: string | null;
    deferrer: { id: string; full_name: string } | null;
    contract: ContractRel | null;
  };

  interface OutDoc {
    id: string;
    label: string;
    status: "pending" | "deferred";
    deferred_at: string | null;
    deferred_reason: string | null;
    deferred_until: string | null;
    deferrer_name: string | null;
    is_overdue: boolean;
  }
  interface OutContract {
    id: string;
    contract_number: string;
    status: string;
    customer_name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    location_id: string | null;
    location_name: string | null;
    created_at: string;
    docs: OutDoc[];
  }

  const map = new Map<string, OutContract>();

  for (const r of (rows ?? []) as unknown as DocRow[]) {
    const c = r.contract;
    if (!c) continue;
    if (!contractStatuses.includes(c.status)) continue;

    const isOverdue = r.status === "deferred" && !!r.deferred_until && r.deferred_until < today;
    if (overdueOnly && !isOverdue) continue;

    if (!map.has(c.id)) {
      const fn = c.lead?.first_name ?? "";
      const ln = c.lead?.last_name ?? "";
      const customerName = [fn, ln].filter(Boolean).join(" ") || "Unknown";
      map.set(c.id, {
        id: c.id,
        contract_number: c.contract_number,
        status: c.status,
        customer_name: customerName,
        company: c.lead?.company ?? null,
        email: c.lead?.email ?? null,
        phone: c.lead?.phone ?? c.lead?.mobile ?? null,
        location_id: c.location?.id ?? null,
        location_name: c.location?.name ?? null,
        created_at: c.created_at,
        docs: [],
      });
    }
    map.get(c.id)!.docs.push({
      id: r.id,
      label: r.label,
      status: r.status,
      deferred_at: r.deferred_at,
      deferred_reason: r.deferred_reason,
      deferred_until: r.deferred_until,
      deferrer_name: r.deferrer?.full_name ?? null,
      is_overdue: isOverdue,
    });
  }

  // Sort contracts: overdue first, then deferred-most, then most pending.
  const contracts = Array.from(map.values())
    .map((c) => ({
      ...c,
      _overdue: c.docs.filter((d) => d.is_overdue).length,
      _deferred: c.docs.filter((d) => d.status === "deferred").length,
      _pending: c.docs.filter((d) => d.status === "pending").length,
    }))
    .sort((a, b) => {
      if (a._overdue !== b._overdue) return b._overdue - a._overdue;
      if (a._deferred !== b._deferred) return b._deferred - a._deferred;
      if (a._pending !== b._pending) return b._pending - a._pending;
      return a.contract_number.localeCompare(b.contract_number);
    });

  // Aggregate summary
  const totalPending  = contracts.reduce((s, c) => s + c._pending, 0);
  const totalDeferred = contracts.reduce((s, c) => s + c._deferred, 0);
  const totalOverdue  = contracts.reduce((s, c) => s + c._overdue, 0);

  return NextResponse.json({
    summary: {
      contracts: contracts.length,
      total_pending: totalPending,
      total_deferred: totalDeferred,
      total_overdue: totalOverdue,
    },
    contracts: contracts.map((c) => {
      // Strip the underscore-prefixed sort keys before sending
      const { _overdue, _deferred, _pending, ...rest } = c;
      void _overdue; void _deferred; void _pending;
      return rest;
    }),
  });
}
