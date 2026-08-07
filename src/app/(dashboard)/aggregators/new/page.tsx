"use client";

import { useRouter } from "next/navigation";
import { AggregatorForm } from "@/components/aggregators/aggregator-form";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { toast } from "sonner";
import { pushTrailEntry } from "@/lib/nav-trail";
import type { CreateAggregatorInput } from "@/lib/validations";

export default function NewAggregatorPage() {
  const router = useRouter();

  const handleSubmit = async (data: CreateAggregatorInput) => {
    const res = await fetch("/api/aggregators", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || "Failed to create aggregator");
      throw new Error(err.error || "Failed to create aggregator");
    }

    const { data: aggregator } = await res.json();
    toast.success("Aggregator created successfully");
    pushTrailEntry({ href: `/aggregators/${aggregator.id}`, label: aggregator.name });
    router.push(`/aggregators/${aggregator.id}`);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <PageBreadcrumb
        current={{ label: "New Aggregator" }}
        fallbackParent={{ href: "/aggregators", label: "Aggregators" }}
      />
      <h1 className="text-2xl font-bold mb-6">Add New Aggregator</h1>
      <AggregatorForm onSubmit={handleSubmit} onCancel={() => router.back()} />
    </div>
  );
}
