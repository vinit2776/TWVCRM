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
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { usePettyCashEntries, usePettyCashCategories } from "@/hooks/use-petty-cash";
import { PC_ENTRY_STATUS_LABELS, PC_ENTRY_STATUS_COLORS } from "@/lib/constants";

export function EntriesTab() {
  const [page, setPage] = useState(1);
  const { data: entries, pagination, loading, refetch } = usePettyCashEntries({ page, my: true });
  const { data: categories } = usePettyCashCategories();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    amount: "",
    category_id: "",
    description: "",
  });

  const handleSubmit = async () => {
    if (!form.amount || !form.description || !form.date) {
      toast.error("Please fill all required fields");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/petty-cash/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: form.date,
          amount: parseFloat(form.amount),
          category_id: form.category_id || undefined,
          description: form.description,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit");
      }
      toast.success("Expense submitted for approval");
      setForm({ date: new Date().toISOString().slice(0, 10), amount: "", category_id: "", description: "" });
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
        <CardTitle className="text-base">My Expenses</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" />Log Expense</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Log Petty Cash Expense</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
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
              <p className="text-xs text-muted-foreground">
                {parseFloat(form.amount) >= 5000
                  ? "This expense will require both manager and admin approval."
                  : "This expense will require manager approval."}
              </p>
              <Button onClick={handleSubmit} disabled={submitting} className="w-full">
                {submitting ? "Submitting..." : "Submit Expense"}
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
    </Card>
  );
}
