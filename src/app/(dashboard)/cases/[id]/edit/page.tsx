"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { CaseForm } from "@/components/cases/case-form";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { useCase } from "@/hooks/use-cases";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { CreateCaseInput } from "@/lib/validations";
import { caseDisplayName } from "@/lib/case-workflow";

export default function EditCasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: caseData, loading } = useCase(id);

  const handleSubmit = async (data: CreateCaseInput) => {
    const res = await fetch(`/api/cases/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || "Failed to update case");
      throw new Error(err.error || "Failed to update case");
    }

    toast.success("Case updated successfully");
    router.push(`/cases/${id}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!caseData) {
    return <div className="text-center py-12">Case not found</div>;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <PageBreadcrumb
        current={{ label: "Edit" }}
        fallbackParent={{ href: `/cases/${id}`, label: caseDisplayName(caseData) }}
      />
      <h1 className="text-2xl font-bold mb-6">Edit: {caseDisplayName(caseData)}</h1>
      <CaseForm
        caseData={caseData}
        onSubmit={handleSubmit}
        onCancel={() => router.push(`/cases/${id}`)}
      />
    </div>
  );
}
