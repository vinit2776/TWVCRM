"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ScrollText, Search, X, CalendarX, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { ContractQuotasSection } from "@/components/contracts/contract-quotas-section";
import { ContractFacilitiesSection } from "@/components/contracts/contract-facilities-section";
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_COLORS,
  CONTRACT_QUOTA_LOCKED_STATUSES,
  CONTRACT_QUOTA_ROLES,
  BILLING_CYCLE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { Contract } from "@/types";

type ContractWithQuotaCount = Contract & {
  lead?: { id: string; first_name: string; last_name: string; company?: string };
  service_quotas?: { count: number }[];
};

function quotaCount(c: ContractWithQuotaCount): number {
  return c.service_quotas?.[0]?.count ?? 0;
}

export default function ContractsPage() {
  const router = useRouter();
  const [contracts, setContracts] = useState<ContractWithQuotaCount[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [expiringSoon, setExpiringSoon] = useState("");
  const [noQuotasFilter, setNoQuotasFilter] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [selectedContract, setSelectedContract] = useState<ContractWithQuotaCount | null>(null);

  useEffect(() => {
    fetch("/api/me").then(r => r.json()).then(d => setUserRole(d.role ?? null));
  }, []);

  const fetchContracts = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    // "Needs Quotas" forces active + high limit so we can client-filter
    const effectiveStatus = noQuotasFilter ? "active" : statusFilter;
    const effectiveLimit = noQuotasFilter ? "200" : "25";
    if (effectiveStatus) params.set("status", effectiveStatus);
    if (effectiveLimit !== "25") params.set("limit", effectiveLimit);
    if (search.trim()) params.set("search", search.trim());
    if (expiringSoon) params.set("expiring_soon", expiringSoon);
    const res = await fetch(`/api/contracts?${params}`);
    if (res.ok) {
      const json = await res.json();
      const rows: ContractWithQuotaCount[] = json.data || [];
      setContracts(noQuotasFilter ? rows.filter(c => quotaCount(c) === 0) : rows);
      setPagination(json.pagination);
    }
    setLoading(false);
  }, [page, statusFilter, search, expiringSoon, noQuotasFilter]);

  useEffect(() => { fetchContracts(); }, [fetchContracts]);

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("");
    setExpiringSoon("");
    setNoQuotasFilter(false);
    setPage(1);
  };

  const toggleNoQuotas = () => {
    setNoQuotasFilter(v => !v);
    setExpiringSoon("");
    setStatusFilter("");
    setPage(1);
  };

  const hasFilters = search || statusFilter || expiringSoon || noQuotasFilter;
  const canEditQuotas = userRole && (CONTRACT_QUOTA_ROLES as readonly string[]).includes(userRole);

  const openQuotaSheet = (e: React.MouseEvent, c: ContractWithQuotaCount) => {
    e.stopPropagation();
    setSelectedContract(c);
  };

  // Refresh quota count for the contract in the list after sheet edits
  const refreshSelectedQuotaCount = async () => {
    if (!selectedContract) return;
    const res = await fetch(`/api/contracts/${selectedContract.id}/quotas`);
    if (!res.ok) return;
    const json = await res.json();
    const count = (json.data || []).length;
    setContracts(prev => prev.map(c =>
      c.id === selectedContract.id
        ? { ...c, service_quotas: [{ count }] }
        : c
    ));
    // Update selectedContract too so the sheet header badge reflects the change
    setSelectedContract(prev => prev ? { ...prev, service_quotas: [{ count }] } : prev);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Contracts</h1>
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Loading…"
              : noQuotasFilter
              ? `${contracts.length} active contracts without quotas`
              : `${pagination.total} total contracts`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search contracts..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9 w-[200px]"
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setNoQuotasFilter(false); setPage(1); }}
          >
            <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {CONTRACT_STATUSES.map((s) => <SelectItem key={s} value={s}>{CONTRACT_STATUS_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            variant={expiringSoon === "60" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setExpiringSoon(expiringSoon === "60" ? "" : "60");
              setNoQuotasFilter(false);
              setStatusFilter("");
              setPage(1);
            }}
          >
            <CalendarX className="mr-1 h-4 w-4" />
            Renewals Due
          </Button>
          {canEditQuotas && (
            <Button
              variant={noQuotasFilter ? "default" : "outline"}
              size="sm"
              onClick={toggleNoQuotas}
            >
              <Settings2 className="mr-1 h-4 w-4" />
              Needs Quotas
            </Button>
          )}
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="mr-1 h-4 w-4" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {loading ? <TableSkeleton rows={6} /> : contracts.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={noQuotasFilter ? "All active contracts have quotas set" : "No contracts found"}
          description={noQuotasFilter ? "Nothing to configure." : "Create contracts from lead detail pages."}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Contract #</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Lead</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Billing Cycle</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Start Date</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">End Date</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Location</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Quotas</th>
            </tr></thead>
            <tbody>{contracts.map((c) => {
              const qCount = quotaCount(c);
              const isActive = c.status === "active" || c.status === "renewal_in_progress";
              return (
                <tr
                  key={c.id}
                  className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => router.push(`/contracts/${c.id}`)}
                >
                  <td className="px-4 py-3 font-mono text-xs">{c.contract_number}</td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {c.lead ? (
                      <Link
                        href={`/leads/${c.lead.id}`}
                        className="text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.lead.company || `${c.lead.first_name} ${c.lead.last_name}`}
                      </Link>
                    ) : "-"}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">{formatCurrency(c.total_amount)}</td>
                  <td className="px-4 py-3 hidden lg:table-cell">{BILLING_CYCLE_LABELS[c.billing_cycle]}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{formatDate(c.start_date)}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{formatDate(c.end_date)}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{c.location?.name || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary" className={CONTRACT_STATUS_COLORS[c.status]}>
                        {CONTRACT_STATUS_LABELS[c.status]}
                      </Badge>
                      {c.is_renewal && (
                        <span title={`Renewal V${c.renewal_sequence || 2}`}>
                          <RefreshCw className="h-3 w-3 text-blue-500" />
                        </span>
                      )}
                      {c.renewal_declined && (
                        <span className="text-[9px] text-red-600 font-medium" title="Renewal declined">✕ Declined</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {canEditQuotas ? (
                      <button
                        onClick={(e) => openQuotaSheet(e, c)}
                        className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors hover:opacity-80 ${
                          qCount > 0
                            ? "border-green-300 bg-green-50 text-green-700"
                            : isActive
                            ? "border-amber-300 bg-amber-50 text-amber-700"
                            : "border-border text-muted-foreground"
                        }`}
                        title="Manage service quotas"
                      >
                        <Settings2 className="h-3 w-3" />
                        {qCount > 0 ? `${qCount} set` : "None"}
                      </button>
                    ) : (
                      <span className={`text-xs ${qCount > 0 ? "text-green-700" : "text-muted-foreground"}`}>
                        {qCount > 0 ? `${qCount} set` : "—"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}

      {!noQuotasFilter && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}

      <Sheet open={!!selectedContract} onOpenChange={(open) => { if (!open) setSelectedContract(null); }}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {selectedContract && (
            <>
              <SheetHeader className="mb-4">
                <SheetTitle className="flex items-center gap-2">
                  <span className="font-mono text-sm">{selectedContract.contract_number}</span>
                  <span className="text-muted-foreground font-normal text-sm">
                    — {selectedContract.lead?.company || `${selectedContract.lead?.first_name ?? ""} ${selectedContract.lead?.last_name ?? ""}`.trim() || "Unknown"}
                  </span>
                </SheetTitle>
              </SheetHeader>
              {/* Active/terminal contracts: only admin can edit quotas. */}
              {selectedContract && (() => {
                const isLocked = (CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(selectedContract.status);
                const sheetReadOnly = !canEditQuotas || (isLocked && userRole !== "admin");
                return (
                  <div className="space-y-4">
                    {isLocked && userRole !== "admin" && (
                      <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                        This contract is active. Only an admin can modify quotas.
                      </p>
                    )}
                    <ContractQuotasSection
                      contractId={selectedContract.id}
                      readOnly={sheetReadOnly}
                      onSave={refreshSelectedQuotaCount}
                    />
                    <ContractFacilitiesSection
                      contractId={selectedContract.id}
                      locationId={selectedContract.location_id ?? null}
                      readOnly={sheetReadOnly}
                      onSave={refreshSelectedQuotaCount}
                    />
                  </div>
                );
              })()}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
