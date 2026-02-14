"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { LeadForm } from "@/components/leads/lead-form";
import { useLead } from "@/hooks/use-leads";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { toast } from "sonner";
import type { CreateLeadInput } from "@/lib/validations";

export default function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: lead, loading } = useLead(id);

  const handleSubmit = async (data: CreateLeadInput) => {
    const res = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || "Failed to update lead");
      throw new Error(err.error || "Failed to update lead");
    }

    toast.success("Lead updated successfully");
    router.push(`/leads/${id}`);
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </div>
    );
  }

  if (!lead) {
    return <div className="text-center py-12">Lead not found</div>;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">
        Edit: {lead.first_name} {lead.last_name}
      </h1>
      <LeadForm
        lead={lead}
        onSubmit={handleSubmit}
        onCancel={() => router.push(`/leads/${id}`)}
      />
    </div>
  );
}
