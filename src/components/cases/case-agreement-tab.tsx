"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  FileText,
  Send,
  CheckCircle,
  PenTool,
  Loader2,
  ExternalLink,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import type { CaseAgreement } from "@/types";

interface CaseAgreementTabProps {
  caseId: string;
}

export function CaseAgreementTab({ caseId }: CaseAgreementTabProps) {
  const [agreement, setAgreement] = useState<CaseAgreement | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [acting, setActing] = useState(false);

  const fetchAgreement = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}`);
      if (res.ok) {
        const json = await res.json();
        setAgreement(json.data?.agreement || null);
      }
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    fetchAgreement();
  }, [fetchAgreement]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate agreement");
      }
      toast.success("Agreement generated");
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleAction = async (action: string) => {
    if (!agreement) return;
    setActing(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/agreement`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, agreement_id: agreement.id }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Action failed");
      }
      toast.success(`Agreement ${action.replace(/_/g, " ")}`);
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  };

  const handleInitiateSigning = async () => {
    setActing(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/agreement/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "initiate" }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to initiate signing");
      }
      toast.success("E-signing initiated via Digio");
      fetchAgreement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Signing initiation failed");
    } finally {
      setActing(false);
    }
  };

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">Loading agreement...</div>;
  }

  if (!agreement) {
    return (
      <div className="text-center py-12">
        <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">No Agreement Generated</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Generate an agreement from the case details to proceed.
        </p>
        <Button onClick={handleGenerate} disabled={generating}>
          {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Generate Agreement
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {agreement.agreement_number || "Agreement"}
            </CardTitle>
            <StatusBadge type="agreement_status" value={agreement.status} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground block">Template</span>
              <span className="capitalize">{agreement.template_key?.replace(/vo_/, "").replace(/_/g, " ")}</span>
            </div>
            <div>
              <span className="text-muted-foreground block">Created</span>
              <span>{formatDate(agreement.created_at)}</span>
            </div>
            {agreement.valid_from && (
              <div>
                <span className="text-muted-foreground block">Valid From</span>
                <span>{formatDate(agreement.valid_from)}</span>
              </div>
            )}
            {agreement.signed_at && (
              <div>
                <span className="text-muted-foreground block">Signed</span>
                <span>{formatDate(agreement.signed_at)}</span>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {agreement.status === "draft" && (
              <Button
                size="sm"
                onClick={() => handleAction("approve_internally")}
                disabled={acting}
              >
                <CheckCircle className="mr-2 h-4 w-4" />
                Approve Internally
              </Button>
            )}

            {agreement.status === "internally_approved" && (
              <Button
                size="sm"
                onClick={() => handleAction("send_to_client")}
                disabled={acting}
              >
                <Send className="mr-2 h-4 w-4" />
                Send to Client
              </Button>
            )}

            {agreement.status === "sent_to_client" && (
              <Button
                size="sm"
                onClick={() => handleAction("client_approved")}
                disabled={acting}
              >
                <CheckCircle className="mr-2 h-4 w-4" />
                Mark Client Approved
              </Button>
            )}

            {agreement.status === "client_approved" && (
              <Button
                size="sm"
                onClick={handleInitiateSigning}
                disabled={acting}
              >
                <PenTool className="mr-2 h-4 w-4" />
                Initiate E-Signing
              </Button>
            )}

            {agreement.digio_sign_url && agreement.status === "signing" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.open(agreement.digio_sign_url!, "_blank")}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Signing Link
              </Button>
            )}

            {acting && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
