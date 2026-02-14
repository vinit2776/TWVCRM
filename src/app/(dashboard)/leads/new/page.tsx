"use client";

import { useRouter } from "next/navigation";
import { LeadForm } from "@/components/leads/lead-form";
import { toast } from "sonner";
import type { CreateLeadInput } from "@/lib/validations";

export default function NewLeadPage() {
  const router = useRouter();

  const handleSubmit = async (data: CreateLeadInput) => {
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || "Failed to create lead");
      throw new Error(err.error || "Failed to create lead");
    }

    const { data: lead } = await res.json();
    toast.success("Lead created successfully");
    router.push(`/leads/${lead.id}`);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Create New Lead</h1>
      <LeadForm onSubmit={handleSubmit} onCancel={() => router.back()} />
    </div>
  );
}
