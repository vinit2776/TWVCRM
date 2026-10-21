"use client";

import { Suspense } from "react";
import { useRouter } from "next/navigation";
import { CaseForm } from "@/components/cases/case-form";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { pushTrailEntry } from "@/lib/nav-trail";
import type { CreateCaseInput } from "@/lib/validations";
import { caseDisplayName } from "@/lib/case-workflow";

function NewCaseContent() {
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
    pushTrailEntry({ href: `/cases/${newCase.id}`, label: caseDisplayName(newCase) });
    router.push(`/cases/${newCase.id}`);
  };

  // Renewals no longer start here: Start renewal on the case raises the bill,
  // and payment creates the next term's case with KYC carried over.
  return (
    <div className="max-w-4xl mx-auto">
      <PageBreadcrumb
        current={{ label: "New Case" }}
        fallbackParent={{ href: "/cases", label: "Cases" }}
      />
      <h1 className="text-2xl font-bold mb-6">Create New Case</h1>
      <CaseForm
        onSubmit={handleSubmit}
        onCancel={() => router.back()}
      />
    </div>
  );
}

export default function NewCasePage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    }>
      <NewCaseContent />
    </Suspense>
  );
}
