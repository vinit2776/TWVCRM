"use client";

import { Lock, Unlock, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";

interface PeriodStatusBarProps {
  period: {
    id: string;
    status: string;
    locked_at?: string;
    locker?: { full_name: string } | null;
  } | null;
  totals: {
    total_billable: number;
    total_collected: number;
    total_outstanding: number;
    cash_pending_handover: number;
    total_carried_forward?: number;
  };
  userRole: string | null;
  onLockToggle: () => void;
  onExport: () => void;
  isLocking: boolean;
}

export function PeriodStatusBar({
  period,
  totals,
  userRole,
  onLockToggle,
  onExport,
  isLocking,
}: PeriodStatusBarProps) {
  const isLocked = period?.status === "locked";
  const canLock = ["admin", "manager", "floor_manager"].includes(userRole || "");
  const canUnlock = userRole === "admin";

  return (
    <div className="space-y-4">
      {/* Status row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge
            variant="outline"
            className={
              isLocked
                ? "bg-red-100 text-red-800 border-red-200"
                : "bg-green-100 text-green-800 border-green-200"
            }
          >
            {isLocked ? "Locked" : "Open"}
          </Badge>
          {isLocked && period?.locker && (
            <span className="text-xs text-muted-foreground">
              Locked by {period.locker.full_name}
              {period.locked_at && ` on ${new Date(period.locked_at).toLocaleDateString("en-IN")}`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onExport}>
            <Download className="h-4 w-4 mr-1" />
            Export
          </Button>
          {((isLocked && canUnlock) || (!isLocked && canLock)) && (
            <Button
              variant={isLocked ? "outline" : "destructive"}
              size="sm"
              onClick={onLockToggle}
              disabled={isLocking}
            >
              {isLocked ? (
                <>
                  <Unlock className="h-4 w-4 mr-1" />
                  {isLocking ? "Unlocking..." : "Unlock Period"}
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4 mr-1" />
                  {isLocking ? "Locking..." : "Lock Period"}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard
          label="Total Billable"
          value={formatCurrency(totals.total_billable)}
          color="text-foreground"
        />
        <SummaryCard
          label="Total Collected"
          value={formatCurrency(totals.total_collected)}
          color="text-green-600"
        />
        <SummaryCard
          label="Outstanding"
          value={formatCurrency(totals.total_outstanding)}
          color={totals.total_outstanding > 0 ? "text-red-600" : "text-foreground"}
        />
        <SummaryCard
          label="Cash Pending Handover"
          value={formatCurrency(totals.cash_pending_handover)}
          color={totals.cash_pending_handover > 0 ? "text-amber-600" : "text-foreground"}
        />
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}
