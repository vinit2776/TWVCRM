"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  ClipboardCheck, CheckCircle2, XCircle, Clock, Loader2,
  Gift, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApprovalRequest {
  id: string;
  approval_type: string;
  entity_type: string;
  entity_id: string;
  entity_reference: string | null;
  requested_by: string;
  requested_at: string;
  created_at: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  status: string;
  acted_by: string | null;
  acted_at: string | null;
  rejection_reason: string | null;
  expires_at: string | null;
  requester?: { id: string; full_name: string; email: string; role: string } | null;
  actor?: { id: string; full_name: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function timeLeft(iso: string): string {
  const diff = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (diff <= 0) return "Expired";
  if (diff < 3600) return `${Math.floor(diff / 60)}m left`;
  return `${Math.floor(diff / 3600)}h left`;
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "approved": return <Badge className="text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border border-emerald-200">Approved</Badge>;
    case "rejected": return <Badge className="text-xs bg-red-100 text-red-700 hover:bg-red-100 border border-red-200">Rejected</Badge>;
    case "expired":  return <Badge className="text-xs bg-slate-100 text-slate-600 hover:bg-slate-100 border border-slate-200">Expired</Badge>;
    default:         return <Badge className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">Pending</Badge>;
  }
}

const TYPE_LABELS: Record<string, string> = {
  comp_request:         "Comp Request",
  escalation_reduction: "Escalation Reduction",
  escalation_waiver:    "Escalation Waiver",
  unifi_adhoc_voucher:  "WiFi Voucher",
};

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function CompRequestRow({
  req,
  canAct,
  onActed,
}: {
  req: ApprovalRequest;
  canAct: boolean;
  onActed: () => void;
}) {
  const meta = req.metadata || {};
  const [acting, setActing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  const bookingRef = String(meta.booking_number ?? req.entity_reference ?? req.entity_id);

  const handleAction = async (action: "approve" | "reject") => {
    if (action === "reject" && !rejectionReason.trim()) {
      toast.error("Please provide a rejection reason");
      return;
    }
    setActing(true);
    try {
      const res = await fetch(`/api/approval-requests/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "reject" ? { rejection_reason: rejectionReason.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || `Failed to ${action}`);
        return;
      }
      toast.success(json.message || `Request ${action}d`);
      onActed();
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-3 hover:bg-muted/10 transition-colors">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gift className="h-4 w-4 text-emerald-600 shrink-0" />
          <div>
            <div className="flex items-center gap-2">
              <Badge className="text-[10px] px-1.5 py-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                {TYPE_LABELS[req.approval_type] || req.approval_type}
              </Badge>
              <StatusBadge status={req.status} />
            </div>
            <p className="text-sm font-medium mt-0.5">
              <Link href={`/bookings/${bookingRef}`} className="hover:underline text-primary font-mono">
                {bookingRef}
              </Link>
              {meta.space_name ? <span className="text-muted-foreground font-normal"> — {String(meta.space_name)}</span> : null}
            </p>
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(req.requested_at || req.created_at)}</span>
      </div>

      {/* Details */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">Requested by: </span>
          {(req.requester as { full_name?: string } | null)?.full_name || "Unknown"}
        </div>
        {meta.total_amount_with_gst != null && Number(meta.total_amount_with_gst) > 0 && (
          <div>
            <span className="font-medium text-foreground">Total to waive: </span>
            ₹{Number(meta.total_amount_with_gst).toLocaleString("en-IN")}
          </div>
        )}
        {meta.reason_label != null && (
          <div>
            <span className="font-medium text-foreground">Reason: </span>
            {String(meta.reason_label)}
          </div>
        )}
        {req.expires_at && req.status === "pending" && (
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            <span className={new Date(req.expires_at) < new Date() ? "text-red-600" : ""}>
              {timeLeft(req.expires_at)}
            </span>
          </div>
        )}
      </div>

      {meta.details != null && (
        <p className="text-xs text-muted-foreground italic border-l-2 border-border pl-2">
          &ldquo;{String(meta.details)}&rdquo;
        </p>
      )}

      {/* Resolved state */}
      {req.status === "rejected" && req.rejection_reason && (
        <p className="text-xs bg-red-50 border border-red-200 rounded px-2 py-1.5 text-red-700">
          <strong>Rejection reason:</strong> {req.rejection_reason}
        </p>
      )}
      {req.status !== "pending" && req.actor && (
        <p className="text-xs text-muted-foreground">
          {req.status === "approved" ? "Approved" : req.status === "rejected" ? "Rejected" : "Handled"} by{" "}
          {(req.actor as { full_name?: string }).full_name || "Unknown"}
          {req.acted_at ? ` · ${timeAgo(req.acted_at)}` : ""}
        </p>
      )}

      {/* Action buttons (pending only, for authorised roles) */}
      {req.status === "pending" && canAct && (
        <div className="space-y-2 pt-1">
          {rejecting && (
            <Input
              autoFocus
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Reason for rejection (required)…"
              className="h-8 text-xs"
            />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
              disabled={acting}
              onClick={() => handleAction("approve")}
            >
              {acting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
              Approve Comp
            </Button>
            {rejecting ? (
              <Button
                size="sm" variant="destructive" className="flex-1 h-8 text-xs"
                disabled={acting || !rejectionReason.trim()}
                onClick={() => handleAction("reject")}
              >
                {acting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                Confirm Reject
              </Button>
            ) : (
              <Button
                size="sm" variant="outline" className="flex-1 h-8 text-xs text-destructive hover:text-destructive"
                onClick={() => { setRejecting(true); setRejectionReason(""); }}
              >
                <XCircle className="h-3 w-3 mr-1" />Reject
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ApprovalsPage() {
  const [requests, setRequests]     = useState<ApprovalRequest[]>([]);
  const [history, setHistory]       = useState<ApprovalRequest[]>([]);
  const [loading, setLoading]       = useState(true);
  const [userRole, setUserRole]     = useState<string | null>(null);
  const [userId, setUserId]         = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const isApprover = userRole === "admin" || userRole === "manager";

  const fetchData = useCallback(async () => {
    try {
      // Fetch pending
      const pendingRes = await fetch("/api/approval-requests?status=pending&limit=50");
      if (pendingRes.ok) {
        const json = await pendingRes.json();
        const all = (json.data || []) as ApprovalRequest[];
        // Floor managers only see their own comp requests
        setRequests(
          isApprover
            ? all.filter(r => r.approval_type === "comp_request")
            : all.filter(r => r.approval_type === "comp_request" && r.requested_by === userId)
        );
      }

      // Fetch recent resolved (last 30 days)
      const historyRes = await fetch("/api/approval-requests?limit=100");
      if (historyRes.ok) {
        const json = await historyRes.json();
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const resolved = ((json.data || []) as ApprovalRequest[]).filter(
          r => r.approval_type === "comp_request"
            && r.status !== "pending"
            && new Date(r.created_at) > cutoff
            && (isApprover || r.requested_by === userId)
        );
        setHistory(resolved);
      }
    } finally {
      setLoading(false);
    }
  }, [isApprover, userId]);

  useEffect(() => {
    fetch("/api/me")
      .then(r => r.json())
      .then(j => { setUserRole(j.role || null); setUserId(j.id || null); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (userRole !== null) fetchData();
  }, [userRole, fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  return (
    <div className="container max-w-3xl py-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-purple-600" />
            Approvals
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isApprover
              ? "Review and act on pending approval requests."
              : "Track the status of your approval requests."}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : (
        <Tabs defaultValue="pending">
          <TabsList className="w-full">
            <TabsTrigger value="pending" className="flex-1">
              Pending
              {requests.length > 0 && (
                <Badge className="ml-2 text-[10px] bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">
                  {requests.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="flex-1">
              History
              {history.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-[10px]">{history.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Pending tab */}
          <TabsContent value="pending" className="mt-4 space-y-3">
            {requests.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <CheckCircle2 className="h-10 w-10 text-green-400 mx-auto mb-3" />
                  <p className="text-sm font-medium">All clear</p>
                  <p className="text-xs text-muted-foreground mt-1">No pending approval requests.</p>
                </CardContent>
              </Card>
            ) : (
              requests.map(req => (
                <CompRequestRow
                  key={req.id}
                  req={req}
                  canAct={isApprover}
                  onActed={fetchData}
                />
              ))
            )}
          </TabsContent>

          {/* History tab */}
          <TabsContent value="history" className="mt-4 space-y-3">
            {history.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">No resolved requests in the last 30 days.</p>
                </CardContent>
              </Card>
            ) : (
              history.map(req => (
                <CompRequestRow
                  key={req.id}
                  req={req}
                  canAct={false}
                  onActed={fetchData}
                />
              ))
            )}

            {history.length > 0 && (
              <p className="text-xs text-center text-muted-foreground py-2">
                Showing resolved requests from the last 30 days.
              </p>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
