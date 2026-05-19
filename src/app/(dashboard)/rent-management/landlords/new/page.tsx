"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export default function NewLandlordPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",
    pan_number: "",
    gstin: "",
    email: "",
    phone: "",
    registered_address: "",
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const body = {
        name: form.name,
        pan_number: form.pan_number || null,
        gstin: form.gstin || null,
        email: form.email || null,
        phone: form.phone || null,
        registered_address: form.registered_address || null,
      };

      const res = await fetch("/api/rent-management/landlords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create landlord");
      }

      const { data } = await res.json();
      toast.success("Landlord created");
      router.push(`/rent-management/landlords/${data.id}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/rent-management/landlords"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">New Landlord</h1>
          <p className="text-sm text-muted-foreground">Add a new landlord entity</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Basic Details</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label>Full Name / Entity Name *</Label>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} required placeholder="e.g. Ramesh Kumar Jain" />
            </div>
            <div className="space-y-2">
              <Label>PAN Number</Label>
              <Input value={form.pan_number} onChange={(e) => set("pan_number", e.target.value.toUpperCase())} placeholder="ABCDE1234F" maxLength={10} />
            </div>
            <div className="space-y-2">
              <Label>GSTIN</Label>
              <Input value={form.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} placeholder="22ABCDE1234F1Z5" maxLength={15} />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="landlord@example.com" />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+91 9876543210" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Address</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label>Registered Address</Label>
              <Textarea value={form.registered_address} onChange={(e) => set("registered_address", e.target.value)} rows={3} placeholder="Full address including city, state, pincode" />
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3 justify-end">
          <Button variant="outline" type="button" asChild>
            <Link href="/rent-management/landlords">Cancel</Link>
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? "Creating..." : "Create Landlord"}
          </Button>
        </div>
      </form>
    </div>
  );
}
