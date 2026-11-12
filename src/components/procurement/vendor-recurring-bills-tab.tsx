"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  RECURRING_BILL_RULE_DEPARTMENTS,
  PROCUREMENT_DEPARTMENT_LABELS,
  RECURRING_BILL_RULE_STATUS_LABELS,
  RECURRING_BILL_RULE_STATUS_COLORS,
  PAYMENT_BATCH_TYPES,
  PAYMENT_BATCH_TYPE_LABELS,
  RECURRING_BILL_RULE_DEFAULT_TOLERANCE_PERCENT,
  RECURRING_BILL_RULE_DEFAULT_MAX_AUTO_APPROVE_AMOUNT,
} from "@/lib/constants";
import type { RecurringBillRule, VendorBill } from "@/types";

const BILLING_CYCLES = ["monthly", "quarterly", "yearly"] as const;
const BILLING_CYCLE_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

export function VendorRecurringBillsTab({ vendorId, isAdmin }: { vendorId: string; isAdmin: boolean }) {
  const [rules, setRules] = useState<RecurringBillRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [eligibleBills, setEligibleBills] = useState<VendorBill[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);

  const [department, setDepartment] = useState<string>("administration");
  const [billingCycle, setBillingCycle] = useState<string>("monthly");
  const [anchorBillId, setAnchorBillId] = useState<string>("");
  const [tolerance, setTolerance] = useState(String(RECURRING_BILL_RULE_DEFAULT_TOLERANCE_PERCENT));
  const [cap, setCap] = useState(String(RECURRING_BILL_RULE_DEFAULT_MAX_AUTO_APPROVE_AMOUNT));
  const [batchType, setBatchType] = useState<string>("15th");
  const [notes, setNotes] = useState("");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [rulesRes, billsRes] = await Promise.all([
      fetch(`/api/procurement/vendors/${vendorId}/recurring-bill-rules`),
      fetch(`/api/procurement/bills?vendor_id=${vendorId}&approval_status=approved&limit=50`),
    ]);
    if (rulesRes.ok) setRules((await rulesRes.json()).data ?? []);
    if (billsRes.ok) setEligibleBills((await billsRes.json()).data ?? []);
    setLoading(false);
  }, [vendorId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const hasActiveRule = rules.some((r) => r.status === "active");

  async function handleCreate() {
    if (!anchorBillId) {
      toast.error("Select the approved bill to anchor this rule to");
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/procurement/vendors/${vendorId}/recurring-bill-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        department,
        billing_cycle: billingCycle,
        anchor_bill_id: anchorBillId,
        tolerance_percent: Number(tolerance),
        max_auto_approve_amount: Number(cap),
        default_batch_type: batchType,
        notes: notes.trim() || null,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) {
      toast.error(json.error ?? "Failed to create rule");
      return;
    }
    toast.success("Recurring bill rule created");
    setShowForm(false);
    setNotes("");
    setAnchorBillId("");
    fetchAll();
  }

  async function handlePauseResume(rule: RecurringBillRule) {
    setBusyRuleId(rule.id);
    const action = rule.status === "active" ? "pause" : "resume";
    const res = await fetch(`/api/procurement/vendors/${vendorId}/recurring-bill-rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const json = await res.json();
    setBusyRuleId(null);
    if (!res.ok) {
      toast.error(json.error ?? "Failed to update rule");
      return;
    }
    toast.success(action === "pause" ? "Rule paused" : "Rule resumed");
    fetchAll();
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">Loading recurring bill rules…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Pre-approve this vendor&apos;s recurring invoices so future bills skip manual approval, within the limits
          you set below.
        </p>
        {isAdmin && !hasActiveRule && eligibleBills.length > 0 && (
          <Button size="sm" onClick={() => setShowForm((s) => !s)}>
            <Plus className="h-4 w-4 mr-1.5" /> New rule
          </Button>
        )}
      </div>

      {isAdmin && !hasActiveRule && eligibleBills.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-6 text-sm text-muted-foreground text-center">
            This vendor has no manually-approved bill yet. A recurring rule can only be set up once at least one real
            invoice has been approved — that bill becomes the baseline.
          </CardContent>
        </Card>
      )}

      {isAdmin && showForm && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Set up a recurring rule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Anchor bill</Label>
                <Select value={anchorBillId} onValueChange={setAnchorBillId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an approved bill" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleBills.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.bill_number} — {formatCurrency(b.total_amount)} ({formatDate(b.invoice_date)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">The expected amount is taken from this bill&apos;s total.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Department</Label>
                <Select value={department} onValueChange={setDepartment}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RECURRING_BILL_RULE_DEPARTMENTS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {PROCUREMENT_DEPARTMENT_LABELS[d] ?? d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Billing cycle</Label>
                <Select value={billingCycle} onValueChange={setBillingCycle}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BILLING_CYCLES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {BILLING_CYCLE_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Default payment batch</Label>
                <Select value={batchType} onValueChange={setBatchType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_BATCH_TYPES.map((b) => (
                      <SelectItem key={b} value={b}>
                        {PAYMENT_BATCH_TYPE_LABELS[b]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Tolerance (%)</Label>
                <Input type="number" min={0} max={100} value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
                <p className="text-xs text-muted-foreground">Auto-approve if within this % of the anchor bill&apos;s amount.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Hard cap (₹)</Label>
                <Input type="number" min={0} value={cap} onChange={(e) => setCap(e.target.value)} />
                <p className="text-xs text-muted-foreground">Auto-approval never applies above this, even if within tolerance.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes (optional)</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
          </CardContent>
          <div className="flex justify-end gap-2 px-6 pb-4">
            <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={saving}>
              {saving ? "Saving…" : "Save rule"}
            </Button>
          </div>
        </Card>
      )}

      {rules.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center">No recurring bill rules yet.</div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <Card key={rule.id}>
              <CardContent className="py-4 flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">
                      {PROCUREMENT_DEPARTMENT_LABELS[rule.department] ?? rule.department}
                    </span>
                    <Badge className={RECURRING_BILL_RULE_STATUS_COLORS[rule.status]}>
                      {RECURRING_BILL_RULE_STATUS_LABELS[rule.status]}
                    </Badge>
                    {!rule.first_bill_id && (
                      <Badge variant="outline" className="text-xs">
                        Awaiting first-bill confirmation
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {formatCurrency(rule.expected_amount)} / {rule.billing_cycle} · tolerance ±{rule.tolerance_percent}% ·
                    cap {formatCurrency(rule.max_auto_approve_amount)} · batch{" "}
                    {PAYMENT_BATCH_TYPE_LABELS[rule.default_batch_type] ?? rule.default_batch_type}
                  </div>
                  {rule.anchor_bill && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Anchored to {rule.anchor_bill.bill_number} ({formatDate(rule.anchor_bill.invoice_date)})
                    </div>
                  )}
                </div>
                {isAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyRuleId === rule.id}
                    onClick={() => handlePauseResume(rule)}
                  >
                    {rule.status === "active" ? "Pause" : "Resume"}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
