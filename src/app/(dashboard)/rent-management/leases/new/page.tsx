"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import type { Location } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { preventEnterSubmit } from "@/lib/utils";

interface Landlord { id: string; name: string; kyc_status: string; }

export default function NewLeasePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [landlords, setLandlords] = useState<Landlord[]>([]);

  const [form, setForm] = useState({
    location_id: "",
    landlord_id: "",
    lease_number: "",
    lease_start_date: "",
    lease_end_date: "",
    lock_in_end_date: "",
    rent_due_day: "1",
    advance_months: "2",
    base_rent_amount: "",
    security_deposit_amount: "0",
    escalation_type: "none",
    escalation_value: "",
    escalation_frequency: "annual",
    next_escalation_date: "",
    tds_section: "194I",
    tds_rate: "10",
    notes: "",
  });

  useEffect(() => {
    Promise.all([
      fetch("/api/locations").then((r) => r.json()),
      fetch("/api/rent-management/landlords").then((r) => r.json()),
    ]).then(([locJson, llJson]) => {
      setLocations(locJson.data || locJson || []);
      setLandlords(llJson.data || []);
    });
  }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const body = {
        location_id: form.location_id,
        landlord_id: form.landlord_id || null,
        lease_number: form.lease_number || null,
        lease_start_date: form.lease_start_date,
        lease_end_date: form.lease_end_date,
        lock_in_end_date: form.lock_in_end_date || null,
        rent_due_day: parseInt(form.rent_due_day),
        advance_months: parseInt(form.advance_months),
        base_rent_amount: parseFloat(form.base_rent_amount),
        security_deposit_amount: parseFloat(form.security_deposit_amount) || 0,
        escalation_type: form.escalation_type,
        escalation_value: form.escalation_value ? parseFloat(form.escalation_value) : null,
        escalation_frequency: form.escalation_frequency,
        next_escalation_date: form.next_escalation_date || null,
        tds_applicable: true,
        tds_section: form.tds_section,
        tds_rate: parseFloat(form.tds_rate),
        notes: form.notes || null,
      };

      const res = await fetch("/api/rent-management/leases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || err.error || "Failed to create lease");
      }

      const { data } = await res.json();
      toast.success("Lease created successfully");
      router.push(`/rent-management/leases/${data.id}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <PageBreadcrumb
        current={{ label: "New Lease" }}
        fallbackParent={{ href: "/rent-management/leases", label: "Leases" }}
      />
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/rent-management/leases"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">New Lease</h1>
          <p className="text-sm text-muted-foreground">Add a new facility lease agreement</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-6">
        {/* Location & Landlord */}
        <Card>
          <CardHeader><CardTitle className="text-base">Property Details</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Location *</Label>
              <Select value={form.location_id} onValueChange={(v) => set("location_id", v)} required>
                <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
                <SelectContent>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Landlord *</Label>
              <Select value={form.landlord_id} onValueChange={(v) => set("landlord_id", v)} required>
                <SelectTrigger><SelectValue placeholder="Select landlord" /></SelectTrigger>
                <SelectContent>
                  {landlords.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Lease Number</Label>
              <Input value={form.lease_number} onChange={(e) => set("lease_number", e.target.value)} placeholder="e.g. LEASE-2024-001" />
            </div>
          </CardContent>
        </Card>

        {/* Term */}
        <Card>
          <CardHeader><CardTitle className="text-base">Lease Term</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Start Date *</Label>
              <Input type="date" value={form.lease_start_date} onChange={(e) => set("lease_start_date", e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>End Date *</Label>
              <Input type="date" value={form.lease_end_date} onChange={(e) => set("lease_end_date", e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Lock-in End Date</Label>
              <Input type="date" value={form.lock_in_end_date} onChange={(e) => set("lock_in_end_date", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Rent Due Day (1–28)</Label>
              <Input type="number" value={form.rent_due_day} onChange={(e) => set("rent_due_day", e.target.value)} min="1" max="28" />
            </div>
          </CardContent>
        </Card>

        {/* Financials */}
        <Card>
          <CardHeader><CardTitle className="text-base">Financials</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Base Rent (₹/month) *</Label>
              <Input type="number" value={form.base_rent_amount} onChange={(e) => set("base_rent_amount", e.target.value)} required min="0" step="0.01" />
            </div>
            <div className="space-y-2">
              <Label>Security Deposit (₹)</Label>
              <Input type="number" value={form.security_deposit_amount} onChange={(e) => set("security_deposit_amount", e.target.value)} min="0" step="0.01" />
            </div>
            <div className="space-y-2">
              <Label>Advance Months</Label>
              <Input type="number" value={form.advance_months} onChange={(e) => set("advance_months", e.target.value)} min="0" />
            </div>
          </CardContent>
        </Card>

        {/* TDS */}
        <Card>
          <CardHeader><CardTitle className="text-base">TDS Configuration</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>TDS Section</Label>
              <Select value={form.tds_section} onValueChange={(v) => {
                set("tds_section", v);
                set("tds_rate", v === "194I" ? "10" : "5");
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="194I">194I — Commercial (10%)</SelectItem>
                  <SelectItem value="194IB">194IB — Residential (5%)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>TDS Rate (%)</Label>
              <Input type="number" value={form.tds_rate} onChange={(e) => set("tds_rate", e.target.value)} min="0" max="30" step="0.01" />
            </div>
          </CardContent>
        </Card>

        {/* Escalation */}
        <Card>
          <CardHeader><CardTitle className="text-base">Escalation</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Escalation Type</Label>
              <Select value={form.escalation_type} onValueChange={(v) => set("escalation_type", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="percentage">Percentage (%)</SelectItem>
                  <SelectItem value="flat">Flat Amount (₹)</SelectItem>
                  <SelectItem value="step_up">Step-up (custom)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.escalation_type !== "none" && (
              <>
                <div className="space-y-2">
                  <Label>{form.escalation_type === "percentage" ? "Escalation %" : "Escalation Amount (₹)"}</Label>
                  <Input type="number" value={form.escalation_value} onChange={(e) => set("escalation_value", e.target.value)} min="0" step="0.01" />
                </div>
                <div className="space-y-2">
                  <Label>Frequency</Label>
                  <Select value={form.escalation_frequency} onValueChange={(v) => set("escalation_frequency", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="annual">Annual</SelectItem>
                      <SelectItem value="bi_annual">Bi-Annual</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Next Escalation Date</Label>
                  <Input type="date" value={form.next_escalation_date} onChange={(e) => set("next_escalation_date", e.target.value)} />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Notes */}
        <Card>
          <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
          <CardContent>
            <Textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Any additional notes about this lease..."
              rows={3}
            />
          </CardContent>
        </Card>

        <div className="flex gap-3 justify-end">
          <Button variant="outline" type="button" asChild>
            <Link href="/rent-management/leases">Cancel</Link>
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? "Creating..." : "Create Lease"}
          </Button>
        </div>
      </form>
    </div>
  );
}
