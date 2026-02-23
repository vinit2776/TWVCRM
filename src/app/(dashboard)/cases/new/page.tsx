"use client";

import { useRouter } from "next/navigation";
import { CaseForm } from "@/components/cases/case-form";
import { toast } from "sonner";
import type { CreateCaseInput } from "@/lib/validations";

export default function NewCasePage() {
  const router = useRouter();

  const handleSubmit = async (data: CreateCaseInput) => {
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || "Failed to create case");
      throw new Error(err.error || "Failed to create case");
    }

    const { data: newCase } = await res.json();
    toast.success("Case created successfully");
    router.push(`/cases/${newCase.id}`);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Create New Case</h1>
      <CaseForm onSubmit={handleSubmit} onCancel={() => router.back()} />
    </div>
  );
}
