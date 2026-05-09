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
                {/* Gap indicator */}
                {idx > 0 && (
                  <div className="flex flex-col items-center justify-center px-1">
                    {gap > 0 ? (
                      <div className="flex flex-col items-center">
                        <div className="border-l-2 border-dashed border-amber-400 h-3" />
                        <span className="text-[8px] text-amber-600 font-medium px-1 py-0.5 bg-amber-50 rounded">
                          {gap}d gap
                        </span>
                        <div className="border-l-2 border-dashed border-amber-400 h-3" />
                      </div>
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-blue-400" />
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
