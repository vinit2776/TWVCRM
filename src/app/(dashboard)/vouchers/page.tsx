"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, Ticket, Upload, Search, X, LayoutGrid, List, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { UploadVouchersDialog } from "@/components/vouchers/upload-vouchers-dialog";
import { VoucherInventoryCard } from "@/components/vouchers/voucher-inventory-card";
import { LowStockAlert } from "@/components/vouchers/low-stock-alert";
import { ReclassifyVouchersDialog } from "@/components/vouchers/reclassify-vouchers-dialog";
import { VoucherIssuanceDialog } from "@/components/vouchers/voucher-issuance-dialog";
import { UnifiPanel } from "@/components/vouchers/unifi-panel";
import { LocationSelector } from "@/components/shared/location-selector";
import { useLocations } from "@/hooks/use-locations";
import {
  VOUCHER_STATUSES,
  VOUCHER_STATUS_LABELS,
  VOUCHER_STATUS_COLORS,
  VOUCHER_VALIDITY_OPTIONS,
  VOUCHER_VALIDITY_LABELS,
} from "@/lib/constants";
import { formatDate, getValidityLabel } from "@/lib/utils";
import type { VoucherInventoryGroup } from "@/types";

interface Voucher {
  id: string;
  voucher_code: string;
  status: string;
  validity_days?: number | null;
  metadata: Record<string, unknown>;
  uploaded_at: string;
  issued_at?: string;
  created_at: string;
  location?: { id: string; name: string; code: string } | null;
}

type TabType = "inventory" | "all" | "unifi_live";

export default function VouchersPage() {
  const [activeTab, setActiveTab] = useState<TabType>("inventory");

  // Inventory state
  const [inventory, setInventory] = useState<VoucherInventoryGroup[]>([]);
  const [lowStockAlerts, setLowStockAlerts] = useState<VoucherInventoryGroup[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(true);

  // All-vouchers state
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [validityFilter, setValidityFilter] = useState("");
  const [search, setSearch] = useState("");

  // Issuance side-panel
  const [issuanceVoucherId, setIssuanceVoucherId] = useState<string | null>(null);

  // Location filter (shared across tabs)
  const [locationFilter, setLocationFilter] = useState<string | null>(null);

  // Upload dialog
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadPreselectedValidity, setUploadPreselectedValidity] = useState<number | undefined>();

  // Reclassify dialog
  const [reclassifyOpen, setReclassifyOpen] = useState(false);

  // Resolve current user role
  const [userRole, setUserRole] = useState<string>("sales_rep");
  useEffect(() => {
    fetch("/api/me").then(r => r.json()).then(d => { if (d.role) setUserRole(d.role); }).catch(() => {});
  }, []);

  // Resolve selected location details (to check unifi_site_id)
  const { locations } = useLocations();
  const selectedLocation = locationFilter
    ? locations.find((l) => l.id === locationFilter) ?? null
    : null;
  const isUnifiLocation = Boolean(selectedLocation?.unifi_site_id);

  // When a UniFi location is selected, auto-switch to the live tab
  useEffect(() => {
    if (isUnifiLocation) {
      setActiveTab("unifi_live");
    } else if (activeTab === "unifi_live") {
      setActiveTab("inventory");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUnifiLocation]);

  // Fetch inventory
  const fetchInventory = useCallback(async () => {
    setInventoryLoading(true);
    const params = new URLSearchParams();
    if (locationFilter) params.set("location_id", locationFilter);
    const res = await fetch(`/api/vouchers/inventory?${params}`);
    if (res.ok) {
      const json = await res.json();
      setInventory(json.data || []);
      setLowStockAlerts(json.low_stock_alerts || []);
    }
    setInventoryLoading(false);
  }, [locationFilter]);

  // Fetch all vouchers
  const fetchVouchers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (statusFilter) params.set("status", statusFilter);
    if (validityFilter) params.set("validity_days", validityFilter);
    if (locationFilter) params.set("location_id", locationFilter);
    if (search.trim()) params.set("search", search.trim());
    const res = await fetch(`/api/vouchers?${params}`);
    if (res.ok) {
      const json = await res.json();
      setVouchers(json.data || []);
      setPagination(json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 });
    }
    setLoading(false);
  }, [page, statusFilter, validityFilter, locationFilter, search]);

  useEffect(() => {
    if (activeTab === "inventory") fetchInventory();
    else if (activeTab === "all") fetchVouchers();
    // unifi_live fetches its own data inside UnifiPanel
  }, [activeTab, fetchInventory, fetchVouchers]);

  const clearFilters = () => {
    setSearch(""); setStatusFilter(""); setValidityFilter(""); setLocationFilter(null); setPage(1);
  };
  const hasFilters = search || statusFilter || validityFilter || locationFilter;

  const handleRefill = (validityDays: number | null) => {
    setUploadPreselectedValidity(validityDays ?? undefined);
    setUploadOpen(true);
  };

  const handleUploadSuccess = () => {
    fetchInventory();
    if (activeTab === "all") fetchVouchers();
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Voucher Repository</h1>
          <p className="text-sm text-muted-foreground">
            Manage WiFi voucher inventory and issuance
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LocationSelector
            value={locationFilter}
            onValueChange={(val) => { setLocationFilter(val); setPage(1); }}
            includeAllOption
            placeholder="All Locations"
          />
          {/* Hide upload for UniFi-managed locations — they use the API, not batch imports */}
          {!isUnifiLocation && (
            <Button onClick={() => { setUploadPreselectedValidity(undefined); setUploadOpen(true); }}>
              <Upload className="mr-2 h-4 w-4" />
              Upload Vouchers
            </Button>
          )}
        </div>
      </div>

      {/* UniFi location badge */}
      {isUnifiLocation && selectedLocation && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-primary/5 border border-primary/20 text-sm">
          <Wifi className="h-4 w-4 text-primary" />
          <span>
            <strong>{selectedLocation.name}</strong> is managed via the UniFi API.
            Vouchers are issued and revoked in real-time — no batch imports needed.
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {/* Hide Inventory + All Vouchers tabs for UniFi locations — they're not applicable */}
        {!isUnifiLocation && (
          <>
            <TabButton
              active={activeTab === "inventory"}
              onClick={() => setActiveTab("inventory")}
              icon={<LayoutGrid className="h-4 w-4" />}
              label="Inventory"
            />
            <TabButton
              active={activeTab === "all"}
              onClick={() => setActiveTab("all")}
              icon={<List className="h-4 w-4" />}
              label="All Vouchers"
            />
          </>
        )}
        {isUnifiLocation && (
          <TabButton
            active={activeTab === "unifi_live"}
            onClick={() => setActiveTab("unifi_live")}
            icon={<Wifi className="h-4 w-4" />}
            label="Live (API)"
          />
        )}
      </div>

      {/* ===== UniFi Live Tab ===== */}
      {activeTab === "unifi_live" && isUnifiLocation && selectedLocation && (
        <UnifiPanel
          locationId={selectedLocation.id}
          locationName={selectedLocation.name}
          userRole={userRole}
        />
      )}

      {/* ===== Inventory Tab ===== */}
      {activeTab === "inventory" && (
        <div className="space-y-4">
          <LowStockAlert alerts={lowStockAlerts} />
          {inventoryLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[180px]" />)}
            </div>
          ) : inventory.length === 0 ? (
            <EmptyState
              icon={Ticket}
              title="No vouchers in inventory"
              description="Upload voucher PDFs to start building your inventory."
              actionLabel="Upload Vouchers"
              onAction={() => { setUploadPreselectedValidity(undefined); setUploadOpen(true); }}
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {inventory.map((group) => (
                <VoucherInventoryCard
                  key={group.validity_days ?? "null"}
                  group={group}
                  onRefill={handleRefill}
                  onReclassify={group.validity_days === null ? () => setReclassifyOpen(true) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== All Vouchers Tab ===== */}
      {activeTab === "all" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search voucher codes..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="pl-9 w-[220px]"
              />
            </div>
            <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}>
              <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {VOUCHER_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{VOUCHER_STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={validityFilter} onValueChange={(val) => { setValidityFilter(val === "all" ? "" : val); setPage(1); }}>
              <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Validity" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Validity</SelectItem>
                {VOUCHER_VALIDITY_OPTIONS.map((days) => (
                  <SelectItem key={days} value={String(days)}>{VOUCHER_VALIDITY_LABELS[days]}</SelectItem>
                ))}
                <SelectItem value="unclassified">Unclassified</SelectItem>
              </SelectContent>
            </Select>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="mr-1 h-4 w-4" />Clear
              </Button>
            )}
          </div>

          {loading ? <TableSkeleton rows={6} /> : vouchers.length === 0 ? (
            <EmptyState
              icon={Ticket}
              title="No vouchers found"
              description={hasFilters ? "Try adjusting your filters." : "Upload vouchers to get started."}
              actionLabel={!hasFilters ? "Upload Vouchers" : undefined}
              onAction={!hasFilters ? () => setUploadOpen(true) : undefined}
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Voucher Code</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Validity</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Location</th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Uploaded</th>
                    <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Issued</th>
                  </tr>
                </thead>
                <tbody>
                  {vouchers.map((v) => {
                    const clickable = v.status !== "available";
                    return (
                      <tr
                        key={v.id}
                        className={`border-b transition-colors ${clickable ? "cursor-pointer hover:bg-muted/40" : "hover:bg-muted/30"}`}
                        onClick={clickable ? () => setIssuanceVoucherId(v.id) : undefined}
                        title={clickable ? "View issuance details" : undefined}
                      >
                        <td className="px-4 py-3 font-mono text-xs">{v.voucher_code}</td>
                        <td className="px-4 py-3">
                          <Badge variant="secondary" className={VOUCHER_STATUS_COLORS[v.status]}>
                            {VOUCHER_STATUS_LABELS[v.status] || v.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="text-xs">{getValidityLabel(v.validity_days)}</Badge>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">{v.location?.name || "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{formatDate(v.uploaded_at || v.created_at)}</td>
                        <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{v.issued_at ? formatDate(v.issued_at) : "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dialogs */}
      <VoucherIssuanceDialog
        open={!!issuanceVoucherId}
        onOpenChange={(v) => { if (!v) setIssuanceVoucherId(null); }}
        voucherId={issuanceVoucherId}
      />
      <UploadVouchersDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={handleUploadSuccess}
        preselectedValidity={uploadPreselectedValidity}
        preselectedLocationId={locationFilter || undefined}
      />
      <ReclassifyVouchersDialog
        open={reclassifyOpen}
        onOpenChange={setReclassifyOpen}
        count={inventory.find((g) => g.validity_days === null)?.available ?? 0}
        locationId={locationFilter}
        onSuccess={() => { setReclassifyOpen(false); fetchInventory(); }}
      />
    </div>
  );
}

// ─── TabButton helper ─────────────────────────────────────────────────────────

function TabButton({
  active, onClick, icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
