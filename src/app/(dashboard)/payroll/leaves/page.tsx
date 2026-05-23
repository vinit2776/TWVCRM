"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Search, Plus, CheckCircle2, XCircle, Loader2, CalendarDays, Clock } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { LEAVE_TYPE_LABELS, LEAVE_STATUS_COLORS, LEAVE_STATUS_LABELS } from "@/lib/constants";
import type { LeaveRequest, Employee } from "@/types";

export default function LeavesPage() {
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [search, setSearch] = useState("");

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newLeave, setNewLeave] = useState({
    employee_id: "",
    leave_type: "cl" as "cl" | "sl" | "lop",
    from_date: "",
    to_date: "",
    reason: "",
  });

  // Review dialog
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<LeaveRequest | null>(null);
  const [reviewNote, setReviewNote] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [leaveRes, empRes] = await Promise.all([
        fetch("/api/payroll/leaves"),
        fetch("/api/employees"),
      ]);
      const { data: leaveData } = await leaveRes.json();
      const { data: empData } = await empRes.json();
      setLeaves(leaveData ?? []);
      setEmployees(empData ?? []);
    } catch {
      toast.error("Failed to load leaves");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleCreate() {
    if (!newLeave.employee_id || !newLeave.from_date || !newLeave.to_date) {
      toast.error("Fill all required fields");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/payroll/leaves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newLeave, reason: newLeave.reason || null }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Failed"); return; }
      toast.success("Leave request created");
      setCreateOpen(false);
      setNewLeave({ employee_id: "", leave_type: "cl", from_date: "", to_date: "", reason: "" });
      loadData();
    } finally {
      setCreating(false);
    }
  }

  async function handleReview(status: "approved" | "rejected") {
    if (!reviewTarget) return;
    setReviewing(true);
    try {
      const res = await fetch(`/api/payroll/leaves/${reviewTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, review_note: reviewNote || null }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Failed"); return; }
      toast.success(`Leave ${status}`);
      setReviewOpen(false);
      setReviewNote("");
      loadData();
    } finally {
      setReviewing(false);
    }
  }

  const filteredLeaves = leaves.filter(lr => {
    const matchesTab = tab === "pending" ? lr.status === "pending" : true;
    const matchesSearch = !search ||
      lr.employee?.full_name?.toLowerCase().includes(search.toLowerCase()) ||
      lr.employee?.department?.toLowerCase()?.includes(search.toLowerCase());
    return matchesTab && matchesSearch;
  });

  const pendingCount = leaves.filter(l => l.status === "pending").length;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">Leave Management</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Review and approve employee leave requests</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" /> Add Leave Request
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Pending", value: leaves.filter(l => l.status === "pending").length, color: "text-amber-600" },
          { label: "Approved", value: leaves.filter(l => l.status === "approved").length, color: "text-green-600" },
          { label: "Rejected", value: leaves.filter(l => l.status === "rejected").length, color: "text-red-600" },
          { label: "Total Requests", value: leaves.length, color: "" },
        ].map(s => (
          <Card key={s.label} className="py-3">
            <CardHeader className="pb-0 pt-0 px-4"><CardTitle className="text-xs text-muted-foreground">{s.label}</CardTitle></CardHeader>
            <CardContent className="px-4 pb-0"><p className={`text-2xl font-bold ${s.color}`}>{s.value}</p></CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs + Search */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Tabs value={tab} onValueChange={v => setTab(v as "pending" | "all")}>
          <TabsList>
            <TabsTrigger value="pending">
              Pending Approvals {pendingCount > 0 && <Badge className="ml-1.5 text-xs bg-amber-100 text-amber-700">{pendingCount}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="all">All Leaves</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search employee…" className="pl-9 w-60" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Employee</th>
                <th className="text-left px-4 py-2.5 font-medium">Type</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Dates</th>
                <th className="text-center px-4 py-2.5 font-medium hidden md:table-cell">Days</th>
                <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Reason</th>
                <th className="text-center px-4 py-2.5 font-medium">Status</th>
                {tab === "pending" && <th className="px-4 py-2.5" />}
              </tr>
            </thead>
            <tbody>
              {filteredLeaves.map(lr => (
                <tr key={lr.id} className="border-t hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium">{lr.employee?.full_name ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">{lr.employee?.department ?? ""}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className="text-xs" variant="outline">
                      {LEAVE_TYPE_LABELS[lr.leave_type]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground text-xs">
                    {formatDate(lr.from_date)} – {formatDate(lr.to_date)}
                  </td>
                  <td className="px-4 py-3 text-center hidden md:table-cell font-mono">{lr.days_count}</td>
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground max-w-[200px] truncate">{lr.reason ?? "—"}</td>
                  <td className="px-4 py-3 text-center">
                    <Badge className={`text-xs ${LEAVE_STATUS_COLORS[lr.status]}`}>
                      {LEAVE_STATUS_LABELS[lr.status]}
                    </Badge>
                  </td>
                  {tab === "pending" && (
                    <td className="px-4 py-3">
                      {lr.status === "pending" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setReviewTarget(lr); setReviewNote(""); setReviewOpen(true); }}
                        >
                          Review
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {filteredLeaves.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                  {tab === "pending" ? "No pending leave requests" : "No leave requests found"}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><CalendarDays className="h-4 w-4" />Add Leave Request</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Employee *</Label>
              <Select value={newLeave.employee_id} onValueChange={v => setNewLeave(f => ({ ...f, employee_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>
                  {employees.filter(e => e.is_active).map(e => (
                    <SelectItem key={e.id} value={e.id}>{e.full_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Leave Type *</Label>
              <Select value={newLeave.leave_type} onValueChange={v => setNewLeave(f => ({ ...f, leave_type: v as typeof newLeave.leave_type }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cl">Casual Leave (CL)</SelectItem>
                  <SelectItem value="sl">Sick Leave (SL)</SelectItem>
                  <SelectItem value="lop">Loss of Pay (LOP)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>From Date *</Label>
                <Input type="date" value={newLeave.from_date} onChange={e => setNewLeave(f => ({ ...f, from_date: e.target.value }))} />
              </div>
              <div>
                <Label>To Date *</Label>
                <Input type="date" value={newLeave.to_date} onChange={e => setNewLeave(f => ({ ...f, to_date: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label>Reason</Label>
              <Textarea rows={2} placeholder="Optional reason…" value={newLeave.reason} onChange={e => setNewLeave(f => ({ ...f, reason: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Submit Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Review Dialog */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Clock className="h-4 w-4" />Review Leave Request</DialogTitle></DialogHeader>
          {reviewTarget && (
            <div className="space-y-4 py-2">
              <div className="bg-muted/40 rounded-lg p-3 text-sm space-y-1.5">
                <div className="flex justify-between"><span className="text-muted-foreground">Employee</span><span className="font-medium">{reviewTarget.employee?.full_name}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Leave Type</span><span>{LEAVE_TYPE_LABELS[reviewTarget.leave_type]}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Dates</span><span>{formatDate(reviewTarget.from_date)} – {formatDate(reviewTarget.to_date)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Days</span><span className="font-mono">{reviewTarget.days_count}</span></div>
                {reviewTarget.reason && <div className="flex justify-between"><span className="text-muted-foreground">Reason</span><span className="text-right max-w-[200px]">{reviewTarget.reason}</span></div>}
              </div>
              <div>
                <Label>Review Note (optional)</Label>
                <Textarea rows={2} placeholder="Add a note…" value={reviewNote} onChange={e => setReviewNote(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setReviewOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => handleReview("rejected")} disabled={reviewing}>
              {reviewing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <XCircle className="h-4 w-4 mr-2" />}
              Reject
            </Button>
            <Button onClick={() => handleReview("approved")} disabled={reviewing}>
              {reviewing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
