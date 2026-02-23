"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Loader2, IndianRupee } from "lucide-react";
import { toast } from "sonner";
import { VO_PURPOSES, VO_PURPOSE_LABELS } from "@/lib/constants";
import { LocationSelector } from "@/components/shared/location-selector";
import { formatCurrency } from "@/lib/utils";
import type { AggregatorRateCard } from "@/types";

interface AggregatorRateCardsTabProps {
  aggregatorId: string;
}

export function AggregatorRateCardsTab({ aggregatorId }: AggregatorRateCardsTabProps) {
  const [rateCards, setRateCards] = useState<AggregatorRateCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    purpose: "" as string,
    location_id: "" as string,
    rate: "",
    tenure_months: "12",
  });

  const fetchRateCards = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/aggregators/${aggregatorId}/rate-cards`);
      if (res.ok) {
        const json = await res.json();
        setRateCards(json.data || []);
      }
    } finally {
      setLoading(false);
    }
  }, [aggregatorId]);

  useEffect(() => {
    fetchRateCards();
  }, [fetchRateCards]);

  const handleAdd = async () => {
    if (!formData.purpose || !formData.rate) {
      toast.error("Purpose and rate are required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/aggregators/${aggregatorId}/rate-cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose: formData.purpose,
          location_id: formData.location_id || undefined,
          rate: parseFloat(formData.rate),
          tenure_months: parseInt(formData.tenure_months) || 12,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add rate card");
      }
      toast.success("Rate card added");
      setAddOpen(false);
      setFormData({ purpose: "", location_id: "", rate: "", tenure_months: "12" });
      fetchRateCards();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add rate card");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">{rateCards.length} rate card(s)</h3>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Rate Card
        </Button>
      </div>

      {loading ? (
        <div className="text-center py-8 text-muted-foreground text-sm">Loading...</div>
      ) : rateCards.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No rate cards configured.
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Purpose</th>
                <th className="px-4 py-3 text-left font-medium">Location</th>
                <th className="px-4 py-3 text-left font-medium">Rate</th>
                <th className="px-4 py-3 text-left font-medium">Tenure</th>
              </tr>
            </thead>
            <tbody>
              {rateCards.map((rc) => (
                <tr key={rc.id} className="border-b">
                  <td className="px-4 py-3">{VO_PURPOSE_LABELS[rc.purpose] || rc.purpose}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {(rc as unknown as Record<string, unknown>).location
                      ? ((rc as unknown as Record<string, unknown>).location as { name: string }).name
                      : "All Locations"}
                  </td>
                  <td className="px-4 py-3 font-medium">{formatCurrency(rc.rate)}/mo</td>
                  <td className="px-4 py-3">{rc.tenure_months} months</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Rate Card Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Rate Card</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Purpose *</Label>
              <Select value={formData.purpose} onValueChange={(val) => setFormData({ ...formData, purpose: val })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select purpose" />
                </SelectTrigger>
                <SelectContent>
                  {VO_PURPOSES.map((p) => (
                    <SelectItem key={p} value={p}>{VO_PURPOSE_LABELS[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Location (optional)</Label>
              <LocationSelector
                value={formData.location_id || null}
                onValueChange={(id) => setFormData({ ...formData, location_id: id || "" })}
                includeAllOption
                placeholder="All Locations"
              />
            </div>
            <div className="space-y-2">
              <Label>Monthly Rate (INR) *</Label>
              <Input
                type="number"
                value={formData.rate}
                onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
                placeholder="e.g. 5000"
              />
            </div>
            <div className="space-y-2">
              <Label>Tenure (months)</Label>
              <Input
                type="number"
                value={formData.tenure_months}
                onChange={(e) => setFormData({ ...formData, tenure_months: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Rate Card
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
