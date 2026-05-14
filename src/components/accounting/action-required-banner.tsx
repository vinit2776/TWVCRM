"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertCircle, Banknote, HandCoins, Receipt, ScrollText, ChevronDown, ChevronUp } from "lucide-react";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import type { PettyCashRequest, PettyCashEntry, PaginatedResponse } from "@/types";

interface ContractSummary {
  contract: {
    id: string;
    contract_number: string;
    title: string;
    lead?: { first_name: string; last_name: string; company?: string };
  };
  outstanding: number;
  carried_forward: number;
}

interface CashHandoverItem {
  id: string;
  amount: number;
  display_name: string;
  reference: string;
  collector?: { full_name: string } | null;
}

interface GstEntry {
  contract_id: string;
  contract_number: string;
  company: string;
  total_billable: number;
  total_paid: number;
  gst_invoice_number: string | null;
  gst_invoice_sent_at: string | null;
}

interface ActionItem {
  id: string;
  type: "outstanding" | "cash_handover" | "gst_pending" | "pc_issuance" | "pc_expense";
  label: string;
  description: string;
  amount: number;
  tab: string; // which tab to switch to
}

interface Props {
  contracts: ContractSummary[];
  cashHandovers: CashHandoverItem[];
  gstEntries: GstEntry[];
  onSwitchTab: (tab: string) => void;
}

export function ActionRequiredBanner({ contracts, cashHandovers, gstEntries, onSwitchTab }: Props) {
  const [pcRequests, setPcRequests] = useState<PettyCashRequest[]>([]);
  const [pcEntries, setPcEntries] = useState<PettyCashEntry[]>([]);
  const [expanded, setExpanded] = useState(true);

  const fetchPettyCash = useCallback(async () => {
    try {
      const [reqRes, entRes] = await Promise.all([
        fetch("/api/petty-cash/requests?status=approved&limit=50"),
        fetch("/api/petty-cash/entries?status=pending_admin&limit=50"),
      ]);
      const reqJson: PaginatedResponse<PettyCashRequest> = await reqRes.json();
      const entJson: PaginatedResponse<PettyCashEntry> = await entRes.json();
      setPcRequests(reqJson.data || []);
      setPcEntries(entJson.data || []);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => { fetchPettyCash(); }, [fetchPettyCash]);

  // Build unified action items
  const items: ActionItem[] = [];

  // 1. Contracts with overdue carry-forward (genuinely past-due, not just current-month unpaid)
  for (const cs of contracts) {
    if (cs.carried_forward > 0) {
      const name = cs.contract.lead
        ? `${cs.contract.lead.first_name} ${cs.contract.lead.last_name}${cs.contract.lead.company ? ` (${cs.contract.lead.company})` : ""}`
        : cs.contract.title;
      items.push({
        id: `outstanding-${cs.contract.id}`,
        type: "outstanding",
        label: "Overdue",
        description: `${cs.contract.contract_number} — ${name}`,
        amount: cs.carried_forward,
        tab: "contracts",
      });
    }
  }

  // 2. Cash handovers pending
  for (const ch of cashHandovers) {
    items.push({
      id: `handover-${ch.id}`,
      type: "cash_handover",
      label: "Cash Handover",
      description: `${ch.display_name} — ${ch.reference}${ch.collector ? ` (collected by ${ch.collector.full_name})` : ""}`,
      amount: ch.amount,
      tab: "cash",
    });
  }

  // 3. GST invoices not yet sent — only flag after payment received (can't invoice before payment)
  for (const gst of gstEntries) {
    if (!gst.gst_invoice_sent_at && gst.total_paid > 0 && gst.total_billable > 0) {
      items.push({
        id: `gst-${gst.contract_id}`,
        type: "gst_pending",
        label: "GST Invoice",
        description: `${gst.contract_number} — ${gst.company}`,
        amount: gst.total_billable,
        tab: "gst",
      });
    }
  }

  // 4. Petty cash requests awaiting issuance
  for (const r of pcRequests) {
    const book = r.book as { owner?: { full_name: string } } | undefined;
    items.push({
      id: `pc-req-${r.id}`,
      type: "pc_issuance",
      label: "Issue Cash",
      description: `${r.request_number} — ${book?.owner?.full_name || "Unknown"}: ${r.purpose}`,
      amount: Number(r.amount_requested),
      tab: "petty-cash",
    });
  }

  // 5. Petty cash expenses pending admin approval
  for (const e of pcEntries) {
    const book = e.book as { owner?: { full_name: string } } | undefined;
    items.push({
      id: `pc-ent-${e.id}`,
      type: "pc_expense",
      label: "Approve Expense",
      description: `${e.entry_number} — ${book?.owner?.full_name || e.submitter?.full_name || "Unknown"}: ${e.description}`,
      amount: Number(e.amount),
      tab: "petty-cash",
    });
  }

  if (items.length === 0) return null;

  const badgeStyles: Record<string, string> = {
    outstanding: "bg-red-50 text-red-700 border-red-200",
    cash_handover: "bg-amber-50 text-amber-700 border-amber-200",
    gst_pending: "bg-purple-50 text-purple-700 border-purple-200",
    pc_issuance: "bg-orange-50 text-orange-700 border-orange-200",
    pc_expense: "bg-blue-50 text-blue-700 border-blue-200",
  };

  const typeIcons: Record<string, React.ReactNode> = {
    outstanding: <ScrollText className="h-3.5 w-3.5" />,
    cash_handover: <HandCoins className="h-3.5 w-3.5" />,
    gst_pending: <Receipt className="h-3.5 w-3.5" />,
    pc_issuance: <Banknote className="h-3.5 w-3.5" />,
    pc_expense: <Banknote className="h-3.5 w-3.5" />,
  };

  return (
    <Card className="border-orange-200 bg-orange-50/30">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-orange-500" />
            Action Required ({items.length}) <InfoTooltip text="Pending tasks: outstanding payments, cash handovers, GST invoices, petty cash. Click an item to go to the relevant tab." side="right" />
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="pt-0">
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-lg border bg-white px-3 py-2.5 cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => onSwitchTab(item.tab)}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Badge variant="outline" className={`text-xs shrink-0 flex items-center gap-1 ${badgeStyles[item.type]}`}>
                    {typeIcons[item.type]}
                    {item.label}
                  </Badge>
                  <p className="text-sm truncate">{item.description}</p>
                </div>
                <p className="text-sm font-semibold ml-3 shrink-0">₹{item.amount.toLocaleString("en-IN")}</p>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
