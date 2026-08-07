"use client";

import { useState, useEffect, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import Link from "next/link";
import { Plus, Building2, Search, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  LEASE_STATUS_LABELS, LEASE_STATUS_COLORS,
  ESCALATION_TYPE_LABELS,
} from "@/lib/constants";
import type { PropertyLease } from "@/types";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

export default function LeasesListPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const userRole = user?.role ?? null;
  const [leases, setLeases] = useState<PropertyLease[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    if (userRole !== null && userRole !== "admin") router.replace("/dashboard");
  }, [userRole, router]);

  const fetchLeases = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    const res = await fetch(`/api/rent-management/leases?${params}`);
    if (res.ok) {
      const json = await res.json();
      setLeases(json.data || []);
    }
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { fetchLeases(); }, [fetchLeases]);

  const filtered = leases.filter((l) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      l.location?.name?.toLowerCase().includes(q) ||
      l.landlord?.name?.toLowerCase().includes(q) ||
      l.lease_number?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-6 space-y-6">
      <PageBreadcrumb resetTo={{ label: "Leases" }} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leases</h1>
          <p className="text-sm text-muted-foreground">All facility lease agreements</p>
        </div>
        {userRole === "admin" && (
          <Button asChild>
            <Link href="/rent-management/leases/new">
              <Plus className="h-4 w-4 mr-2" />
              New Lease
            </Link>
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by location, landlord, lease #..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="on_hold">On Hold</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="terminated">Terminated</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {loading ? (
        <TableSkeleton rows={5} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No leases found"
          description={search ? "Try a different search" : "Add your first lease to get started"}
          actionLabel={userRole === "admin" ? "New Lease" : undefined}
          onAction={userRole === "admin" ? () => router.push("/rent-management/leases/new") : undefined}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-3 font-medium">Location</th>
                    <th className="text-left px-4 py-3 font-medium">Landlord</th>
                    <th className="text-left px-4 py-3 font-medium">Lease #</th>
                    <th className="text-right px-4 py-3 font-medium">Base Rent</th>
                    <th className="text-left px-4 py-3 font-medium">Term</th>
                    <th className="text-left px-4 py-3 font-medium">Escalation</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((lease) => (
                    <tr key={lease.id} className="border-b hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3">
                        <Link
                          href={`/rent-management/leases/${lease.id}`}
                          className="font-medium hover:underline text-primary"
                          onClick={() => pushTrailEntry({ href: `/rent-management/leases/${lease.id}`, label: lease.location?.name ?? "Lease" })}
                        >
                          {lease.location?.name ?? "—"}
                        </Link>
                        {lease.location?.city && (
                          <p className="text-xs text-muted-foreground">{lease.location.city}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{lease.landlord?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{lease.lease_number ?? "—"}</td>
                      <td className="px-4 py-3 text-right font-medium">{formatCurrency(lease.base_rent_amount)}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {formatDate(lease.lease_start_date)} →<br />{formatDate(lease.lease_end_date)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {lease.escalation_type === "none" ? (
                          <span className="text-muted-foreground/60">None</span>
                        ) : (
                          <div>
                            <span className="text-xs">{ESCALATION_TYPE_LABELS[lease.escalation_type]}</span>
                            {lease.next_escalation_date && (
                              <p className="text-xs text-muted-foreground">Next: {formatDate(lease.next_escalation_date)}</p>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={LEASE_STATUS_COLORS[lease.status]}>
                          {LEASE_STATUS_LABELS[lease.status]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
