"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  FileText,
  Receipt,
  MoreHorizontal,
  Eye,
  Download,
  CheckCircle,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { AddUsageChargeDialog } from "@/components/billing/add-usage-charge-dialog";
import { GenerateStatementDialog } from "@/components/billing/generate-statement-dialog";
import { ViewStatementDialog } from "@/components/billing/view-statement-dialog";
import { formatDate, formatCurrency } from "@/lib/utils";
import { toast } from "sonner";

// --- Status constants ---

const USAGE_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  billed: "bg-green-100 text-green-800",
  waived: "bg-gray-100 text-gray-800",
};

const USAGE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  billed: "Billed",
  waived: "Waived",
};

const STATEMENT_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  finalized: "bg-blue-100 text-blue-800",
  exported: "bg-green-100 text-green-800",
};

const STATEMENT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  finalized: "Finalized",
  exported: "Exported",
};

// --- Types ---

interface Contract {
  id: string;
  contract_number: string;
  lead?: { first_name: string; last_name: string; company?: string };
}

interface UsageCharge {
  id: string;
  description: string;
  contract_id?: string | null;
  contract?: { contract_number: string } | null;
  booking_id?: string | null;
  booking?: { booking_number: string; booking_date: string } | null;
  lead?: { first_name: string; last_name: string; company?: string } | null;
  quantity: number;
  unit_price: number;
  total: number;
  charge_date: string;
  status: string;
  notes?: string;
}

interface BillingStatement {
  id: string;
  statement_number: string;
  contract_id?: string | null;
  booking_id?: string | null;
  contract?: { contract_number: string } | null;
  booking?: { booking_number: string; booking_date: string; guest_name?: string } | null;
  lead?: { first_name: string; last_name: string; company?: string } | null;
  period_start: string;
  period_end: string;
  fixed_amount: number;
  usage_amount: number;
  total_amount: number;
  status: string;
  notes?: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// --- Component ---

export default function BillingPage() {
  // Tab state
  const [activeTab, setActiveTab] = useState("usage-charges");

  // Usage Charges state
  const [charges, setCharges] = useState<UsageCharge[]>([]);
  const [chargesPagination, setChargesPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [chargesLoading, setChargesLoading] = useState(true);
  const [chargesPage, setChargesPage] = useState(1);
  const [chargesContractFilter, setChargesContractFilter] = useState("");
  const [chargesStatusFilter, setChargesStatusFilter] = useState("");
  const [chargesDateFrom, setChargesDateFrom] = useState("");
  const [chargesDateTo, setChargesDateTo] = useState("");
  const [addChargeOpen, setAddChargeOpen] = useState(false);

  // Billing Statements state
  const [statements, setStatements] = useState<BillingStatement[]>([]);
  const [statementsPagination, setStatementsPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [statementsLoading, setStatementsLoading] = useState(true);
  const [statementsPage, setStatementsPage] = useState(1);
  const [statementsContractFilter, setStatementsContractFilter] = useState("");
  const [statementsStatusFilter, setStatementsStatusFilter] = useState("");
  const [generateStatementOpen, setGenerateStatementOpen] = useState(false);
  const [viewStatementId, setViewStatementId] = useState<string | null>(null);

  // Shared: contract list for filter dropdowns
  const [contracts, setContracts] = useState<Contract[]>([]);

  // Fetch contracts for filter dropdowns
  useEffect(() => {
    fetch("/api/contracts?limit=100")
      .then((res) => res.json())
      .then((json) => setContracts(json.data || []))
      .catch(() => setContracts([]));
  }, []);

  // --- Fetch Usage Charges ---
  const fetchCharges = useCallback(async () => {
    setChargesLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(chargesPage),
        limit: "25",
      });
      if (chargesContractFilter)
        params.set("contract_id", chargesContractFilter);
      if (chargesStatusFilter) params.set("status", chargesStatusFilter);
      if (chargesDateFrom) params.set("date_from", chargesDateFrom);
      if (chargesDateTo) params.set("date_to", chargesDateTo);

      const res = await fetch(`/api/usage-charges?${params}`);
      if (res.ok) {
        const json = await res.json();
        setCharges(json.data || []);
        setChargesPagination(
          json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 }
        );
      }
    } catch {
      toast.error("Failed to load usage charges");
    } finally {
      setChargesLoading(false);
    }
  }, [
    chargesPage,
    chargesContractFilter,
    chargesStatusFilter,
    chargesDateFrom,
    chargesDateTo,
  ]);

  useEffect(() => {
    fetchCharges();
  }, [fetchCharges]);

  // --- Fetch Billing Statements ---
  const fetchStatements = useCallback(async () => {
    setStatementsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(statementsPage),
        limit: "25",
      });
      if (statementsContractFilter)
        params.set("contract_id", statementsContractFilter);
      if (statementsStatusFilter)
        params.set("status", statementsStatusFilter);

      const res = await fetch(`/api/billing-statements?${params}`);
      if (res.ok) {
        const json = await res.json();
        setStatements(json.data || []);
        setStatementsPagination(
          json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 }
        );
      }
    } catch {
      toast.error("Failed to load billing statements");
    } finally {
      setStatementsLoading(false);
    }
  }, [statementsPage, statementsContractFilter, statementsStatusFilter]);

  useEffect(() => {
    fetchStatements();
  }, [fetchStatements]);

  // --- Clear filters ---
  const clearChargesFilters = () => {
    setChargesContractFilter("");
    setChargesStatusFilter("");
    setChargesDateFrom("");
    setChargesDateTo("");
    setChargesPage(1);
  };

  const clearStatementsFilters = () => {
    setStatementsContractFilter("");
    setStatementsStatusFilter("");
    setStatementsPage(1);
  };

  const hasChargesFilters =
    chargesContractFilter ||
    chargesStatusFilter ||
    chargesDateFrom ||
    chargesDateTo;

  const hasStatementsFilters =
    statementsContractFilter || statementsStatusFilter;

  // --- Statement actions ---
  const handleFinalizeStatement = async (id: string) => {
    try {
      const res = await fetch(`/api/billing-statements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "finalized" }),
      });
      if (res.ok) {
        toast.success("Statement finalized");
        fetchStatements();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to finalize statement");
      }
    } catch {
      toast.error("Failed to finalize statement");
    }
  };

  const handleExportStatement = async (id: string) => {
    try {
      const res = await fetch(`/api/billing-statements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "exported" }),
      });
      if (res.ok) {
        toast.success("Statement exported");
        fetchStatements();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to export statement");
      }
    } catch {
      toast.error("Failed to export statement");
    }
  };

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Manage usage charges and billing statements
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="usage-charges" className="gap-1.5">
            <Receipt className="h-4 w-4" />
            Usage Charges
          </TabsTrigger>
          <TabsTrigger value="billing-statements" className="gap-1.5">
            <FileText className="h-4 w-4" />
            Billing Statements
          </TabsTrigger>
        </TabsList>

        {/* ========== USAGE CHARGES TAB ========== */}
        <TabsContent value="usage-charges" className="space-y-4">
          {/* Filters Bar */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={chargesContractFilter}
                onValueChange={(val) => {
                  setChargesContractFilter(val === "all" ? "" : val);
                  setChargesPage(1);
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="All Contracts" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Contracts</SelectItem>
                  {contracts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.contract_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={chargesStatusFilter}
                onValueChange={(val) => {
                  setChargesStatusFilter(val === "all" ? "" : val);
                  setChargesPage(1);
                }}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {Object.entries(USAGE_STATUS_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="date"
                value={chargesDateFrom}
                onChange={(e) => {
                  setChargesDateFrom(e.target.value);
                  setChargesPage(1);
                }}
                className="w-[150px]"
                placeholder="From"
              />
              <Input
                type="date"
                value={chargesDateTo}
                onChange={(e) => {
                  setChargesDateTo(e.target.value);
                  setChargesPage(1);
                }}
                className="w-[150px]"
                placeholder="To"
              />
              {hasChargesFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearChargesFilters}
                >
                  <X className="mr-1 h-4 w-4" />
                  Clear
                </Button>
              )}
            </div>
            <Button onClick={() => setAddChargeOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Charge
            </Button>
          </div>

          {/* Usage Charges Table */}
          {chargesLoading ? (
            <TableSkeleton rows={6} />
          ) : charges.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No usage charges found"
              description={
                hasChargesFilters
                  ? "Try adjusting your filters."
                  : "Add your first usage charge to get started."
              }
              actionLabel={!hasChargesFilters ? "Add Charge" : undefined}
              onAction={
                !hasChargesFilters
                  ? () => setAddChargeOpen(true)
                  : undefined
              }
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">
                      Description
                    </th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">
                      Reference
                    </th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">
                      Quantity
                    </th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">
                      Unit Price
                    </th>
                    <th className="px-4 py-3 text-right font-medium">Total</th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">
                      Charge Date
                    </th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {charges.map((charge) => (
                    <tr
                      key={charge.id}
                      className="border-b hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium max-w-[200px] truncate">
                        {charge.description}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs hidden md:table-cell">
                        {charge.contract?.contract_number ? (
                          <span title="Contract">{charge.contract.contract_number}</span>
                        ) : charge.booking?.booking_number ? (
                          <span className="text-blue-600" title={`Booking — ${formatDate(charge.booking.booking_date)}`}>
                            {charge.booking.booking_number}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">
                        {charge.quantity}
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">
                        {formatCurrency(charge.unit_price)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatCurrency(charge.total)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                        {formatDate(charge.charge_date)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="secondary"
                          className={
                            USAGE_STATUS_COLORS[charge.status] || ""
                          }
                        >
                          {USAGE_STATUS_LABELS[charge.status] || charge.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem>
                              <Eye className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Usage Charges Pagination */}
          {chargesPagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {chargesPagination.page} of {chargesPagination.totalPages} (
                {chargesPagination.total} total)
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={chargesPage <= 1}
                  onClick={() => setChargesPage(chargesPage - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={chargesPage >= chargesPagination.totalPages}
                  onClick={() => setChargesPage(chargesPage + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ========== BILLING STATEMENTS TAB ========== */}
        <TabsContent value="billing-statements" className="space-y-4">
          {/* Filters Bar */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={statementsContractFilter}
                onValueChange={(val) => {
                  setStatementsContractFilter(val === "all" ? "" : val);
                  setStatementsPage(1);
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="All Contracts" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Contracts</SelectItem>
                  {contracts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.contract_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={statementsStatusFilter}
                onValueChange={(val) => {
                  setStatementsStatusFilter(val === "all" ? "" : val);
                  setStatementsPage(1);
                }}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {Object.entries(STATEMENT_STATUS_LABELS).map(
                    ([key, label]) => (
                      <SelectItem key={key} value={key}>
                        {label}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
              {hasStatementsFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearStatementsFilters}
                >
                  <X className="mr-1 h-4 w-4" />
                  Clear
                </Button>
              )}
            </div>
            <Button onClick={() => setGenerateStatementOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Generate Statement
            </Button>
          </div>

          {/* Billing Statements Table */}
          {statementsLoading ? (
            <TableSkeleton rows={6} />
          ) : statements.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No billing statements found"
              description={
                hasStatementsFilters
                  ? "Try adjusting your filters."
                  : "Generate your first billing statement to get started."
              }
              actionLabel={
                !hasStatementsFilters ? "Generate Statement" : undefined
              }
              onAction={
                !hasStatementsFilters
                  ? () => setGenerateStatementOpen(true)
                  : undefined
              }
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">
                      Statement #
                    </th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">
                      Reference
                    </th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">
                      Lead
                    </th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">
                      Period
                    </th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">
                      Fixed
                    </th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">
                      Usage
                    </th>
                    <th className="px-4 py-3 text-right font-medium">Total</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {statements.map((stmt) => (
                    <tr
                      key={stmt.id}
                      className="border-b hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs">
                        {stmt.statement_number}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs hidden md:table-cell">
                        {stmt.contract?.contract_number
                          ? stmt.contract.contract_number
                          : stmt.booking?.booking_number
                          ? stmt.booking.booking_number
                          : "-"}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {stmt.lead
                          ? stmt.lead.company ||
                            `${stmt.lead.first_name} ${stmt.lead.last_name}`
                          : stmt.booking?.guest_name || "-"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                        {formatDate(stmt.period_start)} -{" "}
                        {formatDate(stmt.period_end)}
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">
                        {formatCurrency(stmt.fixed_amount)}
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">
                        {formatCurrency(stmt.usage_amount)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatCurrency(stmt.total_amount)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="secondary"
                          className={
                            STATEMENT_STATUS_COLORS[stmt.status] || ""
                          }
                        >
                          {STATEMENT_STATUS_LABELS[stmt.status] || stmt.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setViewStatementId(stmt.id)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View Detail
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled>
                              <Download className="mr-2 h-4 w-4" />
                              Download PDF
                            </DropdownMenuItem>
                            {stmt.status === "draft" && (
                              <DropdownMenuItem
                                onClick={() =>
                                  handleFinalizeStatement(stmt.id)
                                }
                              >
                                <CheckCircle className="mr-2 h-4 w-4" />
                                Finalize
                              </DropdownMenuItem>
                            )}
                            {stmt.status === "finalized" && (
                              <DropdownMenuItem
                                onClick={() =>
                                  handleExportStatement(stmt.id)
                                }
                              >
                                <Upload className="mr-2 h-4 w-4" />
                                Export
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Billing Statements Pagination */}
          {statementsPagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {statementsPagination.page} of{" "}
                {statementsPagination.totalPages} (
                {statementsPagination.total} total)
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={statementsPage <= 1}
                  onClick={() => setStatementsPage(statementsPage - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={statementsPage >= statementsPagination.totalPages}
                  onClick={() => setStatementsPage(statementsPage + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <AddUsageChargeDialog
        open={addChargeOpen}
        onOpenChange={setAddChargeOpen}
        onSuccess={fetchCharges}
      />
      <GenerateStatementDialog
        open={generateStatementOpen}
        onOpenChange={setGenerateStatementOpen}
        onSuccess={fetchStatements}
      />
      <ViewStatementDialog
        statementId={viewStatementId}
        open={!!viewStatementId}
        onOpenChange={(v) => { if (!v) setViewStatementId(null); }}
        onStatusChange={fetchStatements}
      />
    </div>
  );
}
