"use client";

import { useState, useEffect, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Building2, Search, CheckCircle, AlertCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import type { Landlord } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

const KYC_COLORS: Record<string, string> = {
  verified: "bg-green-100 text-green-800",
  pending: "bg-yellow-100 text-yellow-800",
  incomplete: "bg-red-100 text-red-800",
};
const KYC_LABELS: Record<string, string> = {
  verified: "Verified",
  pending: "Pending",
  incomplete: "Incomplete",
};

export default function LandlordsListPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const userRole = user?.role ?? null;
  const [landlords, setLandlords] = useState<(Landlord & { active_lease_count?: number; bank_accounts?: { is_verified: boolean; is_primary: boolean }[] })[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (userRole !== null && userRole !== "admin") router.replace("/dashboard");
  }, [userRole, router]);

  const fetchLandlords = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/rent-management/landlords");
    if (res.ok) {
      const json = await res.json();
      setLandlords(json.data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchLandlords(); }, [fetchLandlords]);

  const filtered = landlords.filter((l) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      l.name?.toLowerCase().includes(q) ||
      l.pan_number?.toLowerCase().includes(q) ||
      l.gstin?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-6 space-y-6">
      <PageBreadcrumb resetTo={{ label: "Landlords" }} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Landlords</h1>
          <p className="text-sm text-muted-foreground">Manage landlord KYC and banking details</p>
        </div>
        {userRole === "admin" && (
          <Button asChild>
            <Link href="/rent-management/landlords/new">
              <Plus className="h-4 w-4 mr-2" />Add Landlord
            </Link>
          </Button>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, PAN, GSTIN..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <TableSkeleton rows={5} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No landlords found"
          description={search ? "Try a different search" : "Add your first landlord to get started"}
          actionLabel={userRole === "admin" ? "Add Landlord" : undefined}
          onAction={userRole === "admin" ? () => router.push("/rent-management/landlords/new") : undefined}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-3 font-medium">Name</th>
                    <th className="text-left px-4 py-3 font-medium">PAN</th>
                    <th className="text-left px-4 py-3 font-medium">GSTIN</th>
                    <th className="text-left px-4 py-3 font-medium">KYC</th>
                    <th className="text-left px-4 py-3 font-medium">Bank</th>
                    <th className="text-right px-4 py-3 font-medium">Active Leases</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((ll) => {
                    const primaryBank = ll.bank_accounts?.find((b) => b.is_primary);
                    return (
                      <tr key={ll.id} className="border-b hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <Link
                            href={`/rent-management/landlords/${ll.id}`}
                            className="font-medium hover:underline text-primary"
                            onClick={() => pushTrailEntry({ href: `/rent-management/landlords/${ll.id}`, label: ll.name })}
                          >
                            {ll.name}
                          </Link>
                          {ll.email && <p className="text-xs text-muted-foreground">{ll.email}</p>}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{ll.pan_number ?? "—"}</td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{ll.gstin ?? "—"}</td>
                        <td className="px-4 py-3">
                          <Badge className={KYC_COLORS[ll.kyc_status]}>
                            {KYC_LABELS[ll.kyc_status]}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {primaryBank ? (
                            <div className="flex items-center gap-1">
                              {primaryBank.is_verified ? (
                                <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                              ) : (
                                <Clock className="h-3.5 w-3.5 text-yellow-500" />
                              )}
                              <span className="text-xs text-muted-foreground">
                                {primaryBank.is_verified ? "Verified" : "Unverified"}
                              </span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                              <span className="text-xs">No bank</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">{ll.active_lease_count ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
