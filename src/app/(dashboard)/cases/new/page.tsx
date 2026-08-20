"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CaseForm } from "@/components/cases/case-form";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { pushTrailEntry } from "@/lib/nav-trail";
import type { CreateCaseInput } from "@/lib/validations";
import type { VoCase } from "@/types";
import { caseDisplayName } from "@/lib/case-workflow";

function NewCaseContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const renewFrom = searchParams.get("renew_from");

  const [parentCase, setParentCase] = useState<VoCase | null>(null);
  const [loadingParent, setLoadingParent] = useState(!!renewFrom);

  useEffect(() => {
    if (!renewFrom) return;
    fetch(`/api/cases/${renewFrom}`)
      .then((r) => r.json())
      .then((json) => setParentCase(json.data || null))
      .catch(() => toast.error("Failed to load parent case for renewal"))
      .finally(() => setLoadingParent(false));
  }, [renewFrom]);

  const handleSubmit = async (data: CreateCaseInput) => {
    const payload = renewFrom
      ? { ...data, is_renewal: true, parent_case_id: renewFrom }
      : data;

    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || "Failed to create case");
      throw new Error(err.error || "Failed to create case");
    }

    const { data: newCase } = await res.json();
    toast.success(renewFrom ? "Renewal case created" : "Case created successfully");
    pushTrailEntry({ href: `/cases/${newCase.id}`, label: caseDisplayName(newCase) });
    router.push(`/cases/${newCase.id}`);
  };

  if (loadingParent) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <PageBreadcrumb
        current={{ label: "New Case" }}
        fallbackParent={{ href: "/cases", label: "Cases" }}
      />
      <h1 className="text-2xl font-bold mb-2">
        {renewFrom ? "Create Renewal Case" : "Create New Case"}
      </h1>
      {renewFrom && parentCase && (
        <p className="text-sm text-muted-foreground mb-6">
          Renewing {parentCase.case_number} — {caseDisplayName(parentCase)}
        </p>
      )}
      {!renewFrom && <div className="mb-6" />}
      <CaseForm
        caseData={parentCase ?? undefined}
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
