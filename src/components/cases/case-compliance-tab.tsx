"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Loader2,
  Shield,
} from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";
import { useCaseCompliance } from "@/hooks/use-cases";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface CaseComplianceTabProps {
  caseId: string;
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="h-4 w-4 text-gray-400" />,
  passed: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  failed: <XCircle className="h-4 w-4 text-red-500" />,
  waived: <AlertTriangle className="h-4 w-4 text-yellow-500" />,
};

export function CaseComplianceTab({ caseId }: CaseComplianceTabProps) {
  const { data: checks, summary, loading, refetch } = useCaseCompliance(caseId);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [selectedCheck, setSelectedCheck] = useState<string | null>(null);
  const [newStatus, setNewStatus] = useState<string>("passed");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleUpdate = async () => {
    if (!selectedCheck) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/compliance`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_id: selectedCheck,
          status: newStatus,
          notes: notes || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Update failed");
      }

      toast.success("Compliance check updated");
      setUpdateOpen(false);
      setNotes("");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSubmitting(false);
    }
  };

  // Group checks by category
  const grouped: Record<string, typeof checks> = {};
  checks.forEach((check) => {
    const cat = check.check_category || "General";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(check);
  });

  return (
    <div className="space-y-4">
      {/* Summary Bar */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{summary.total} checks</span>
        </div>
        <div className="flex gap-3">
          <span className="text-green-600">{summary.passed} passed</span>
          <span className="text-red-600">{summary.failed} failed</span>
          <span className="text-yellow-600">{summary.waived} waived</span>
          <span className="text-gray-500">{summary.pending} pending</span>
        </div>
        {summary.allPassed && (
          <span className="text-green-600 font-medium flex items-center gap-1">
            <CheckCircle2 className="h-4 w-4" />
            All Passed
          </span>
        )}
        <div className="flex-1" />
        <div className="w-40 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 rounded-full transition-all"
            style={{
              width: `${summary.total > 0 ? ((summary.passed + summary.waived) / summary.total) * 100 : 0}%`,
            }}
          />
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8 text-muted-foreground">Loading compliance checks...</div>
      ) : checks.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No compliance checks for this case.
        </div>
      ) : (
        Object.entries(grouped).map(([category, categoryChecks]) => (
          <div key={category} className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              {category}
            </h4>
            {categoryChecks.map((check) => (
              <Card key={check.id}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {STATUS_ICONS[check.status]}
                      <div>
                        <span className="font-medium text-sm">{check.check_name}</span>
                        {check.notes && (
                          <p className="text-xs text-muted-foreground mt-0.5">{check.notes}</p>
                        )}
                        {check.checker && (
                          <p className="text-xs text-muted-foreground">
                            By {(check.checker as { full_name: string }).full_name}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge type="compliance_status" value={check.status} />
                      {check.status === "pending" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSelectedCheck(check.id);
                            setNewStatus("passed");
                            setNotes("");
                            setUpdateOpen(true);
                          }}
                        >
                          Review
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ))
      )}

      {/* Update Dialog */}
      <Dialog open={updateOpen} onOpenChange={setUpdateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Compliance Check</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Result</label>
              <Select value={newStatus} onValueChange={setNewStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="passed">Passed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="waived">Waived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Notes</label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes..."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpdateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
