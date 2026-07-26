"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { PROCUREMENT_DEPARTMENTS, PROCUREMENT_DEPARTMENT_LABELS } from "@/lib/constants";
import type { ProcurementDepartment } from "@/types";

type ContractOption = {
  id: string;
  contract_number: string;
  lead?: { first_name: string; last_name: string; company?: string };
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prId: string;
  prNumber: string;
  currentDepartment: ProcurementDepartment;
  onSuccess: () => void;
};

export function CorrectDepartmentDialog({
  open, onOpenChange, prId, prNumber, currentDepartment, onSuccess,
}: Props) {
  const [department, setDepartment] = useState<ProcurementDepartment>(currentDepartment);
  const [billableContractId, setBillableContractId] = useState("");
  const [reason, setReason] = useState("");
  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDepartment(currentDepartment);
    setBillableContractId("");
    setReason("");
  }, [open, currentDepartment]);

  useEffect(() => {
    if (department !== "reimbursement" || contracts.length > 0) return;
    fetch("/api/contracts?status=active&limit=100")
      .then((r) => r.json())
      .then((j) => setContracts(j.data ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department]);

  const handleSubmit = async () => {
    if (department === currentDepartment) {
      toast.error("Select a different department to correct to");
      return;
    }
    if (department === "reimbursement" && !billableContractId) {
      toast.error("Select which customer's contract this will be billed to");
      return;
    }
    if (!reason.trim()) {
      toast.error("A reason is required for the audit trail");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/procurement/requests/${prId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "correct_department",
          department,
          billable_contract_id: department === "reimbursement" ? billableContractId : null,
          reason: reason.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to correct department");
        return;
      }
      toast.success(`${prNumber} moved to ${PROCUREMENT_DEPARTMENT_LABELS[department]}`);
      onSuccess();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Correct Department — {prNumber}</DialogTitle>
          <DialogDescription>
            Admin-only correction for an MR filed under the wrong department. This only
            changes the department (and, for Reimbursement, the linked customer contract) —
            status, approvals, POs, and vendor bills are untouched.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="correct-department">Department</Label>
            <Select value={department} onValueChange={(v) => setDepartment(v as ProcurementDepartment)}>
              <SelectTrigger id="correct-department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROCUREMENT_DEPARTMENTS.map((d) => (
                  <SelectItem key={d} value={d}>{PROCUREMENT_DEPARTMENT_LABELS[d]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {department === "reimbursement" && (
            <div className="space-y-1.5">
              <Label htmlFor="correct-department-contract">
                Bill to Customer (Contract) <span className="text-red-500">*</span>
              </Label>
              <Select value={billableContractId} onValueChange={setBillableContractId}>
                <SelectTrigger id="correct-department-contract">
                  <SelectValue placeholder={contracts.length === 0 ? "Loading contracts…" : "Select a contract"} />
                </SelectTrigger>
                <SelectContent>
                  {contracts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.contract_number}
                      {c.lead ? ` — ${c.lead.company || `${c.lead.first_name} ${c.lead.last_name}`}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="correct-department-reason">
              Reason <span className="text-red-500">*</span>
            </Label>
            <Textarea
              id="correct-department-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Filed under Pantry by mistake — should be billed back to the customer"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Save Correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
