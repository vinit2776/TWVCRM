"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw, Loader2, History } from "lucide-react";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { CASE_STATUS_LABELS, CASE_STATUS_COLORS } from "@/lib/constants";
import { formatDate, formatCurrency, cn } from "@/lib/utils";

interface SubscriptionRow {
  id: string;
  case_number: string;
  status: string;
  is_renewal: boolean;
  start_date?: string;
  end_date?: string;
  tenure_months: number;
  rate?: number;
  security_deposit: number;
  renewal_due_at?: string;
}

interface CaseSubscriptionHistoryProps {
  caseId: string;
}

function daysUntil(dateStr?: string): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function CaseSubscriptionHistory({ caseId }: CaseSubscriptionHistoryProps) {
  const router = useRouter();
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/subscriptions`);
      if (!res.ok) throw new Error("Failed to fetch");
      const { data } = await res.json();
      setSubscriptions(data || []);
    } catch {
      setSubscriptions([]);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    fetchSubscriptions();
  }, [fetchSubscriptions]);

  const activeStatuses = new Set(["active", "renewal_due"]);

  // Determine which row is the active subscription
  const activeSub = subscriptions.find((s) => activeStatuses.has(s.status));

  // Show Renew button only when viewing the active/renewal_due case
  const currentSub = subscriptions.find((s) => s.id === caseId);
  const canRenew = currentSub && activeStatuses.has(currentSub.status);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (subscriptions.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground text-sm">
          No subscription history found.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <History className="h-4 w-4" />
          <span>{subscriptions.length} subscription period{subscriptions.length !== 1 ? "s" : ""}</span>
        </div>
        {canRenew && (
          <Button
            size="sm"
            onClick={() => router.push(`/cases/new?renew_from=${caseId}`)}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Renew
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1">Subscription History <InfoTooltip text="All subscription periods for this client including renewals. Color-coded expiry countdowns help track renewal timing." side="right" /></CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Case No.</TableHead>
                <TableHead className="w-[110px]">Start Date</TableHead>
                <TableHead className="w-[60px]">Months</TableHead>
                <TableHead className="w-[110px]">End Date</TableHead>
                <TableHead className="w-[120px]">Expiring In</TableHead>
                <TableHead className="w-[120px]">Monthly Rate</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.map((sub) => {
                const isActive = activeStatuses.has(sub.status);
                const expiryDate = sub.renewal_due_at || sub.end_date;
                const daysLeft = daysUntil(expiryDate);

                return (
                  <TableRow
                    key={sub.id}
                    className={cn(
                      "cursor-pointer hover:bg-muted/50",
                      isActive && "bg-green-50 hover:bg-green-100/70"
                    )}
                    onClick={() => router.push(`/cases/${sub.id}`)}
                  >
                    <TableCell className="font-mono text-xs font-medium">
                      {sub.case_number}
                      {sub.is_renewal && (
                        <span className="ml-1 text-xs text-muted-foreground">(renewal)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {sub.start_date ? formatDate(sub.start_date) : "—"}
                    </TableCell>
                    <TableCell className="text-sm">{sub.tenure_months}</TableCell>
                    <TableCell className="text-sm">
                      {sub.end_date ? formatDate(sub.end_date) : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {daysLeft === null ? (
                        "—"
                      ) : daysLeft < 0 ? (
                        <span className="text-red-600 font-medium">Expired</span>
                      ) : daysLeft === 0 ? (
                        <span className="text-red-600 font-medium">Today</span>
                      ) : daysLeft <= 30 ? (
                        <span className="text-amber-600 font-medium">{daysLeft} days</span>
                      ) : (
                        <span className="text-green-700">{daysLeft} days</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {sub.rate ? formatCurrency(sub.rate) : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn("text-xs", CASE_STATUS_COLORS[sub.status])}
                      >
                        {CASE_STATUS_LABELS[sub.status] ?? sub.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {activeSub && (activeSub.renewal_due_at || activeSub.end_date) && (
        (() => {
          const daysLeft = daysUntil(activeSub.renewal_due_at ?? activeSub.end_date);
          if (daysLeft === null || daysLeft > 60) return null;
          return (
            <div className={cn(
              "rounded-lg border px-4 py-3 text-sm flex items-center justify-between",
              daysLeft <= 0
                ? "border-red-200 bg-red-50 text-red-800"
                : daysLeft <= 30
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-yellow-200 bg-yellow-50 text-yellow-800"
            )}>
              <span>
                {daysLeft <= 0
                  ? "This subscription has expired."
                  : `Renewal due in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}.`}
              </span>
              {canRenew && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-4 border-current"
                  onClick={() => router.push(`/cases/new?renew_from=${caseId}`)}
                >
                  <RefreshCw className="mr-1.5 h-3 w-3" />
                  Renew Now
                </Button>
              )}
            </div>
          );
        })()
      )}
    </div>
  );
}
