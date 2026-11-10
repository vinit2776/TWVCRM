"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { CaseForm } from "@/components/cases/case-form";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { useCase } from "@/hooks/use-cases";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

  // Set when saving would invalidate a signed agreement: the person must accept first.
  const [resetPrompt, setResetPrompt] = useState<{ data: CreateCaseInput } | null>(null);
  const [resetReason, setResetReason] = useState("");
  const [resetting, setResetting] = useState(false);

  const save = async (data: CreateCaseInput, reset?: { reason: string }) => {
    const res = await fetch(`/api/cases/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reset ? { ...data, confirm_agreement_reset: true, agreement_reset_reason: reset.reason } : data),
    });

    if (res.status === 409) {
      const err = await res.json().catch(() => ({}));
      if (err.code === "AGREEMENT_RESET_REQUIRED") {
        setResetPrompt({ data });
        throw new Error("Confirmation needed");
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "Failed to update case");
      throw new Error(err.error || "Failed to update case");
    }

    const body = await res.json().catch(() => ({}));
    if (body.warning) toast.warning(body.warning);
    else if (reset) toast.success("Case updated. The agreement was reset: regenerate it, then get it signed again.");
    else if (body.regenerate_tab) toast.success("Case updated. Regenerate the agreement to pick up the new address.");
    else toast.success("Case updated successfully");
    // Land on the agreement that now needs regenerating, when there is one.
    router.push(body.regenerate_tab ? `/cases/${id}?tab=${body.regenerate_tab}` : `/cases/${id}`);
  };

  const handleSubmit = (data: CreateCaseInput) => save(data);

  const acceptReset = async () => {
    if (!resetPrompt) return;
    setResetting(true);
    try {
      await save(resetPrompt.data, { reason: resetReason.trim() });
      setResetPrompt(null);
    } catch {
      // error already shown by save
    } finally {
      setResetting(false);
    }
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

      <Dialog open={!!resetPrompt} onOpenChange={(o) => { if (!o && !resetting) setResetPrompt(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" /> Reset the signed agreement?
            </DialogTitle>
            <DialogDescription>
              This case has a signed agreement (or one out for e-signature) that carries the old address.
              Changing the address means that signature no longer covers the right details.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>The agreement goes back to a draft. You regenerate it with the new address from the Agreement tab, and it must be <strong>signed again</strong>.</li>
            <li>Any e-signature request still open is withdrawn.</li>
            <li>The old signed file is kept as the previous version.</li>
            <li>The case, billing and invoices are not changed.</li>
          </ul>
          <Textarea
            placeholder="Reason for the change (at least 10 characters)"
            value={resetReason}
            onChange={(e) => setResetReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetPrompt(null)} disabled={resetting}>Cancel</Button>
            <Button onClick={acceptReset} disabled={resetting || resetReason.trim().length < 10}>
              {resetting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Accept and reset agreement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
