"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Pencil, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { usePettyCashEntries, usePettyCashCategories } from "@/hooks/use-petty-cash";
import { PC_ENTRY_STATUS_LABELS, PC_ENTRY_STATUS_COLORS } from "@/lib/constants";
import { AttachmentPicker, AttachmentDialog, uploadAttachments } from "@/components/petty-cash/attachments";
import { needsReceiptNudge, PC_RECEIPT_NUDGE_DEFAULT } from "@/lib/petty-cash-attachments";
import { useFetch } from "@/hooks/use-fetch";

export function EntriesTab() {
  const [page, setPage] = useState(1);
  const { data: entries, pagination, loading, refetch } = usePettyCashEntries({ page, my: true });
  const { data: categories } = usePettyCashCategories();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingEntry, setEditingEntry] = useState<{ id: string; rejection_note?: string | null } | null>(null);
  const emptyForm = { date: new Date().toISOString().slice(0, 10), amount: "", category_id: "", description: "" };
  const [form, setForm] = useState(emptyForm);
  const [billFiles, setBillFiles] = useState<File[]>([]);
  const [billsFor, setBillsFor] = useState<{ id: string; entry_number: string; status: string } | null>(null);
  const { data: nudgeAmount } = useFetch<number>("/api/petty-cash/receipt-policy", {
    initialData: PC_RECEIPT_NUDGE_DEFAULT,
    select: (json) => Number(json.nudgeAmount) || PC_RECEIPT_NUDGE_DEFAULT,
  });

  const openNewDialog = () => {
    setEditingEntry(null);
    setForm(emptyForm);
    setBillFiles([]);
    setOpen(true);
  };

  const openEditDialog = (entry: { id: string; date: string; amount: number; category_id?: string | null; description: string; rejection_note?: string | null }) => {
    setEditingEntry({ id: entry.id, rejection_note: entry.rejection_note });
    setForm({
      date: entry.date.slice(0, 10),
      amount: String(entry.amount),
      category_id: entry.category_id || "",
      description: entry.description,
    });
    setBillFiles([]);
    setOpen(true);
  };

  const handleSubmit = async () => {
    if (!form.amount || !form.description || !form.date) {
      toast.error("Please fill all required fields");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        date: form.date,
        amount: parseFloat(form.amount),
        category_id: form.category_id || undefined,
        description: form.description,
      };

      const res = editingEntry
        ? await fetch(`/api/petty-cash/entries/${editingEntry.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "resubmit", ...payload }),
          })
        : await fetch("/api/petty-cash/entries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit");
      }
      const savedId: string | undefined = editingEntry ? editingEntry.id : (await res.json()).data?.id;
      let failedUploads = 0;
      if (billFiles.length && savedId) failedUploads = await uploadAttachments(billFiles, { entryId: savedId });
      if (failedUploads) {
        toast.warning(`Expense saved, but ${failedUploads} file${failedUploads > 1 ? "s" : ""} did not upload. Open "Add a bill" on the expense to try again.`);
      } else {
        toast.success(editingEntry ? "Expense resubmitted for approval" : "Expense submitted for approval");
      }
      setBillFiles([]);
      setForm(emptyForm);
      setEditingEntry(null);
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
        <div>
          <CardTitle className="text-base">My Expenses</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">Money you spent from your petty cash. Log it here with the bill so your manager can approve it.</p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditingEntry(null); }}>
          <DialogTrigger asChild>
            <Button size="sm" onClick={openNewDialog}><Plus className="h-4 w-4 mr-1" />Log Expense</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingEntry ? "Edit & Resubmit Expense" : "Log Petty Cash Expense"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              {editingEntry?.rejection_note && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm">
                  <p className="font-medium text-red-800">Rejection reason:</p>
                  <p className="text-red-700 mt-1">{editingEntry.rejection_note}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Date</Label>
                  <Input
                    type="date"
                    value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Amount (₹)</Label>
                  <Input
                    type="number"
                    placeholder="e.g. 500"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={form.category_id} onValueChange={(v) => setForm({ ...form, category_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                  <SelectContent>
                    {categories.filter((c) => c.is_active).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  placeholder="What was this expense for?"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <AttachmentPicker
                files={billFiles}
                onChange={setBillFiles}
                label="Bill or proof of payment"
                help="Take a photo of the bill, or pick a photo or PDF. You can submit without one, but approvers decide faster with it."
              />
              {!editingEntry && needsReceiptNudge(parseFloat(form.amount) || 0, billFiles.length, nudgeAmount) && (
                <p className="rounded-md bg-amber-50 text-amber-800 text-sm px-3 py-2">
                  No bill attached for ₹{parseFloat(form.amount).toLocaleString("en-IN")}. You can still submit — the approver will see &quot;no bill&quot;. You can add one later from this list using &quot;Add a bill&quot;.
                </p>
              )}
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
                <p><strong>What happens when you press the button below:</strong></p>
                <p>
                  {parseFloat(form.amount) >= 5000
                    ? "Your manager reviews it first, then Admin/Accounts (amounts of ₹5,000 or more need two approvals). "
                    : "Your manager reviews it. "}
                  The amount comes off your balance only after it is fully approved. If it is rejected you will see the reason here and can fix and resubmit it.
                </p>
              </div>
              <Button onClick={handleSubmit} disabled={submitting} className="w-full">
                {submitting ? "Submitting..." : editingEntry ? "Resubmit for approval" : "Submit for approval"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="animate-pulse space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-12 rounded bg-muted" />)}</div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No expenses logged yet. Click &quot;Log Expense&quot; to record a spend.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Entry #</th>
                    <th className="pb-2 font-medium text-muted-foreground">Date</th>
                    <th className="pb-2 font-medium text-muted-foreground">Amount</th>
                    <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Category</th>
                    <th className="pb-2 font-medium text-muted-foreground hidden lg:table-cell">Description</th>
                    <th className="pb-2 font-medium text-muted-foreground">Status</th>
                    <th className="pb-2 font-medium text-muted-foreground">Bill</th>
                    <th className="pb-2 font-medium text-muted-foreground"></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2.5 font-medium">{e.entry_number}</td>
                      <td className="py-2.5">{new Date(e.date).toLocaleDateString("en-IN")}</td>
                      <td className="py-2.5">₹{Number(e.amount).toLocaleString("en-IN")}</td>
                      <td className="py-2.5 hidden md:table-cell text-muted-foreground">
                        {(e.category as { name: string } | null)?.name || "—"}
                      </td>
                      <td className="py-2.5 hidden lg:table-cell text-muted-foreground truncate max-w-[200px]">{e.description}</td>
                      <td className="py-2.5">
                        <Badge variant="secondary" className={PC_ENTRY_STATUS_COLORS[e.status] || ""}>
                          {PC_ENTRY_STATUS_LABELS[e.status] || e.status}
                        </Badge>
                        {e.status === "rejected" && e.rejection_note && (
                          <p className="text-xs text-red-600 mt-0.5 truncate max-w-[160px]" title={e.rejection_note}>{e.rejection_note}</p>
                        )}
                      </td>
                      <td className="py-2.5">
                        {(() => {
                          const n = e.attachments?.length ?? 0;
                          const missing = needsReceiptNudge(Number(e.amount), n, nudgeAmount);
                          const canAdd = e.status !== "approved";
                          return (
                            <Button size="sm" variant="outline"
                              className={`text-xs h-7 ${missing ? "border-amber-300 text-amber-800 bg-amber-50" : ""}`}
                              onClick={() => setBillsFor({ id: e.id, entry_number: e.entry_number, status: e.status })}>
                              <Paperclip className="h-3 w-3 mr-1" />
                              {n > 0 ? `View bills (${n})` : missing ? "No bill — add one" : canAdd ? "Add a bill" : "No bill"}
                            </Button>
                          );
                        })()}
                      </td>
                      <td className="py-2.5">
                        {e.status === "rejected" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs h-7"
                            onClick={() => openEditDialog(e as { id: string; date: string; amount: number; category_id?: string | null; description: string; rejection_note?: string | null })}
                          >
                            <Pencil className="h-3 w-3 mr-1" />Edit & Resubmit
                          </Button>
                        )}
                      </td>
                    </tr>
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
      {billsFor && (
        <AttachmentDialog
          open
          onOpenChange={(o) => { if (!o) { setBillsFor(null); refetch(); } }}
          title={`Bills for ${billsFor.entry_number}`}
          description={billsFor.status === "approved"
            ? "This expense is approved. Only Accounts can add or remove files now."
            : "Photos or PDFs of the bill or payment proof. Your approver sees these when deciding."}
          target={{ entryId: billsFor.id }}
          canAdd={billsFor.status !== "approved"}
          canRemove={() => billsFor.status !== "approved"}
          addLabel="Add a bill (photo or PDF)"
          emptyText="No bill has been added to this expense yet."
        />
      )}
    </Card>
  );
}
