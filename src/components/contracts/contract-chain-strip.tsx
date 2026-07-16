"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RefreshCw, ChevronRight, Minus } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_COLORS,
} from "@/lib/constants";

interface ChainContract {
  id: string;
  contract_number: string;
  status: string;
  subtotal: number;
  total_amount: number;
  start_date: string;
  end_date: string;
  tenure_months: number;
  seats: number;
  renewal_sequence: number;
  is_renewal: boolean;
  parent_contract_id: string | null;
  escalation_waived: boolean;
}

interface ContractChainStripProps {
  contractId: string;
  leadId: string;
}

/**
 * Shows the monthly-fee change from one contract in the chain to the next
 * (renewal escalation, a waiver, or a flat carry-over). Derived from the
 * actual subtotal delta rather than the stored escalation_percentage field,
 * so it stays accurate even if seats or items were renegotiated at renewal
 * (escalation_percentage alone wouldn't reflect that).
 */
function EscalationBadge({ prev, next }: { prev: ChainContract; next: ChainContract }) {
  const delta = next.subtotal - prev.subtotal;
  const pct = prev.subtotal > 0 ? (delta / prev.subtotal) * 100 : 0;
  const pctLabel = `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(pct).toFixed(Number.isInteger(pct) ? 0 : 1)}%`;
  const deltaLabel = `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${formatCurrency(Math.abs(delta))}/mo`;

  if (next.escalation_waived) {
    return (
      <div className="flex flex-col items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 whitespace-nowrap">
        <span className="text-[9px] font-bold text-amber-700">Waived</span>
        <span className="text-[8px] text-amber-600">{formatCurrency(next.subtotal)}/mo</span>
      </div>
    );
  }

  if (delta === 0) {
    return (
      <div className="flex flex-col items-center gap-0.5 px-1.5 py-0.5 rounded bg-muted border border-muted-foreground/20 whitespace-nowrap">
        <span className="text-[9px] font-bold text-muted-foreground">Flat</span>
      </div>
    );
  }

  const positive = delta > 0;
  return (
    <div
      className={`flex flex-col items-center gap-0.5 px-1.5 py-0.5 rounded border whitespace-nowrap ${
        positive
          ? "bg-emerald-50 border-emerald-200"
          : "bg-rose-50 border-rose-200"
      }`}
    >
      <span className={`text-[9px] font-bold ${positive ? "text-emerald-700" : "text-rose-700"}`}>
        {pctLabel}
      </span>
      <span className={`text-[8px] ${positive ? "text-emerald-600" : "text-rose-600"}`}>
        {deltaLabel}
      </span>
    </div>
  );
}

export function ContractChainStrip({ contractId, leadId }: ContractChainStripProps) {
  const [chain, setChain] = useState<ChainContract[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchChain = useCallback(async () => {
    try {
      // Fetch all contracts for this lead that are part of a chain
      const res = await fetch(`/api/contracts?lead_id=${leadId}&limit=50`);
      if (!res.ok) return;
      const json = await res.json();
      const all = (json.data || []) as ChainContract[];

      // Build the chain: find the root, then follow parent_contract_id links
      // First, find the current contract and trace back to root
      const byId = new Map(all.map((c) => [c.id, c]));

      // Trace back to root from current contract
      let rootId = contractId;
      let current = byId.get(rootId);
      while (current?.parent_contract_id && byId.has(current.parent_contract_id)) {
        rootId = current.parent_contract_id;
        current = byId.get(rootId);
      }

      // Now traverse forward from root collecting the chain
      const chainList: ChainContract[] = [];
      let nodeId: string | null = rootId;
      const visited = new Set<string>();

      while (nodeId && !visited.has(nodeId)) {
        visited.add(nodeId);
        const node = byId.get(nodeId);
        if (node) {
          chainList.push(node);
          // Find child: a contract whose parent_contract_id is this node
          const child = all.find(
            (c) => c.parent_contract_id === nodeId && !visited.has(c.id)
          );
          nodeId = child?.id || null;
        } else {
          break;
        }
      }

      // Only show the strip if there's more than 1 contract in the chain
      if (chainList.length > 1) {
        setChain(chainList);
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, [contractId, leadId]);

  useEffect(() => {
    fetchChain();
  }, [fetchChain]);

  if (loading || chain.length === 0) return null;

  // Calculate gaps between consecutive contracts
  const getGapDays = (prev: ChainContract, next: ChainContract): number => {
    const prevEnd = new Date(prev.end_date).getTime();
    const nextStart = new Date(next.start_date).getTime();
    return Math.max(0, Math.round((nextStart - prevEnd) / 86_400_000) - 1);
  };

  // Customer tenure: from first start_date to last end_date
  const firstStart = chain[0].start_date;
  const lastEnd = chain[chain.length - 1].end_date;
  const totalMonths = chain.reduce((sum, c) => sum + (c.tenure_months || 0), 0);

  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <RefreshCw className="h-3.5 w-3.5 text-blue-600" />
            Contract History
          </CardTitle>
          <span className="text-[10px] text-muted-foreground">
            Customer since {formatDate(firstStart)} &middot; {totalMonths} months across {chain.length} contract{chain.length > 1 ? "s" : ""}
          </span>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0">
        <div className="flex items-stretch gap-0 overflow-x-auto pb-1">
          {chain.map((c, idx) => {
            const isCurrent = c.id === contractId;
            const gap = idx > 0 ? getGapDays(chain[idx - 1], c) : 0;

            return (
              <div key={c.id} className="flex items-stretch shrink-0">
                {/* Gap + escalation indicator */}
                {idx > 0 && (
                  <div className="flex flex-col items-center justify-center gap-1 px-1.5">
                    <ChevronRight className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                    <EscalationBadge prev={chain[idx - 1]} next={c} />
                    {gap > 0 && (
                      <span className="text-[8px] text-amber-600 font-medium px-1 py-0.5 bg-amber-50 rounded whitespace-nowrap">
                        {gap}d gap
                      </span>
                    )}
                  </div>
                )}

                {/* Contract card */}
                <Link
                  href={`/contracts/${c.id}`}
                  className={`
                    block rounded-lg border px-3 py-2 min-w-[140px] transition-all hover:shadow-md
                    ${isCurrent
                      ? "border-blue-500 bg-white ring-2 ring-blue-200 shadow-sm"
                      : "border-muted bg-white/80 hover:bg-white"
                    }
                  `}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-mono text-[11px] font-medium">
                      {c.contract_number}
                    </span>
                    <Badge
                      variant="secondary"
                      className={`${CONTRACT_STATUS_COLORS[c.status]} text-[9px] px-1.5 py-0 h-4`}
                    >
                      {CONTRACT_STATUS_LABELS[c.status]}
                    </Badge>
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold text-primary">
                      {formatCurrency(c.subtotal)}/mo
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {formatDate(c.start_date)} – {formatDate(c.end_date)}
                    </p>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span>{c.tenure_months}mo</span>
                      <Minus className="h-2 w-2" />
                      <span>{c.seats} seat{c.seats !== 1 ? "s" : ""}</span>
                      {c.escalation_waived && (
                        <>
                          <Minus className="h-2 w-2" />
                          <span className="text-amber-600">no esc.</span>
                        </>
                      )}
                    </div>
                  </div>
                  {isCurrent && (
                    <div className="mt-1 text-center">
                      <span className="text-[8px] font-bold uppercase tracking-widest text-blue-600">
                        Current
                      </span>
                    </div>
                  )}
                </Link>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
