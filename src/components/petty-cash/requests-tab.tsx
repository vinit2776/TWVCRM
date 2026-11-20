"use client";

import { Fragment, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Paperclip, Plus } from "lucide-react";
import { toast } from "sonner";
import { usePettyCashRequests } from "@/hooks/use-petty-cash";
import { PC_REQUEST_STATUS_LABELS, PC_REQUEST_STATUS_COLORS, PC_ISSUANCE_METHOD_LABELS } from "@/lib/constants";
import { AttachmentDialog } from "@/components/petty-cash/attachments";
import { formatCurrency } from "@/lib/utils";
import type { PettyCashRequest } from "@/types";

const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "");

/** Where a request is, in words: who did what and what happens next. */
function RequestProgress({ r, onProof }: { r: PettyCashRequest; onProof: () => void }) {
  const steps: { done: boolean; text: string }[] = [
    { done: true, text: `Requested on ${day(r.created_at)}` },
  ];
  if (r.status === "rejected") {
    steps.push({ done: true, text: `Rejected${r.approver?.full_name ? ` by ${r.approver.full_name}` : ""}${r.rejection_note ? ` — "${r.rejection_note}"` : ""}. You can raise a new request.` });
  } else {
    steps.push({
      done: r.status !== "pending",
      text: r.status === "pending" ? "Waiting for an admin to approve" : `Approved${r.approver?.full_name ? ` by ${r.approver.full_name}` : ""} on ${day(r.approved_at)}`,
    });
    steps.push({
      done: r.status === "issued",
      text: r.status === "issued"
        ? `Paid${r.issuer?.full_name ? ` by ${r.issuer.full_name}` : ""} on ${day(r.issued_at)}${r.issuance_method ? ` via ${PC_ISSUANCE_METHOD_LABELS[r.issuance_method] ?? r.issuance_method}` : ""}${r.issuance_reference ? ` · reference ${r.issuance_reference}` : ""}. ${formatCurrency(Number(r.amount_requested))} is now in your petty cash balance and ready to use.`
        : r.status === "approved" ? "Accounts will pay it from Acc Payables and enter the payment reference here. Your balance goes up when they confirm." : "Then Accounts pays it and the reference appears here",
    });
  }
  return (
    <div className="space-y-1 text-xs">
      {steps.map((st, i) => (
        <p key={i} className={st.done ? "text-foreground" : "text-muted-foreground"}>
          <span className={`inline-block w-4 ${st.done ? "text-green-600" : ""}`}>{st.done ? "✓" : "○"}</span>{st.text}
        </p>
      ))}
      {r.status === "issued" && (
        <button type="button" onClick={onProof} className="inline-flex items-center gap-1 text-blue-600 hover:underline mt-1">
          <Paperclip className="h-3 w-3" />View proof of payment
        </button>
      )}
    </div>
  );
}

export function RequestsTab() {
  const [page, setPage] = useState(1);
  const { data: requests, pagination, loading, refetch } = usePettyCashRequests({ page, my: true });
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ amount: "", purpose: "" });
  const [proofFor, setProofFor] = useState<{ id: string; request_number: string } | null>(null);

  const handleSubmit = async () => {
    if (!form.amount || !form.purpose) {
      toast.error("Please fill all fields");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/petty-cash/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_requested: parseFloat(form.amount),
          purpose: form.purpose,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit");
      }
      toast.success("Request submitted successfully");
      setForm({ amount: "", purpose: "" });
      setOpen(false);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">My Funding Requests</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" />New Request</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Request Petty Cash</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Amount (₹)</Label>
                <Input
                  type="number"
                  placeholder="e.g. 10000"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Purpose</Label>
                <Textarea
                  placeholder="What do you need the funds for?"
                  value={form.purpose}
                  onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                />
              </div>
              <Button onClick={handleSubmit} disabled={submitting} className="w-full">
                {submitting ? "Submitting..." : "Submit Request"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="animate-pulse space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-12 rounded bg-muted" />)}</div>
        ) : requests.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No requests yet. Click &quot;New Request&quot; to request petty cash funds.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Request #</th>
                    <th className="pb-2 font-medium text-muted-foreground">Amount</th>
                    <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Purpose</th>
                    <th className="pb-2 font-medium text-muted-foreground">Status</th>
                    <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <Fragment key={r.id}>
                    <tr className="hover:bg-muted/30">
                      <td className="py-2.5 font-medium">{r.request_number}</td>
                      <td className="py-2.5">₹{Number(r.amount_requested).toLocaleString("en-IN")}</td>
                      <td className="py-2.5 hidden md:table-cell text-muted-foreground truncate max-w-[200px]">{r.purpose}</td>
                      <td className="py-2.5">
                        <Badge variant="secondary" className={PC_REQUEST_STATUS_COLORS[r.status] || ""}>
                          {PC_REQUEST_STATUS_LABELS[r.status] || r.status}
                        </Badge>
                      </td>
                      <td className="py-2.5 hidden md:table-cell text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString("en-IN")}
                      </td>
                    </tr>
                    <tr className="border-b last:border-0">
                      <td colSpan={5} className="pb-3 pt-0">
                        <RequestProgress r={r} onProof={() => setProofFor({ id: r.id, request_number: r.request_number })} />
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-muted-foreground">
                  Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                  <Button size="sm" variant="outline" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
      {proofFor && (
        <AttachmentDialog
          open
          onOpenChange={(o) => { if (!o) setProofFor(null); }}
          title={`Proof of payment for ${proofFor.request_number}`}
          description="Added by Accounts when they handed over the cash."
          target={{ requestId: proofFor.id }}
          kind="payment_proof"
          canAdd={false}
          canRemove={() => false}
          addLabel=""
          emptyText="Accounts did not attach proof for this payment."
        />
      )}
    </Card>
  );
}
