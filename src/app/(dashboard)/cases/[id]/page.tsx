"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Edit2,
  Trash2,
  Mail,
  Phone,
  Building,
  MapPin,
  RefreshCw,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { CaseStatusPipeline } from "@/components/cases/case-status-pipeline";
import { CaseDocumentsTab } from "@/components/cases/case-documents-tab";
import { CaseComplianceTab } from "@/components/cases/case-compliance-tab";
import { CaseAgreementTab } from "@/components/cases/case-agreement-tab";
import { CaseLeaveAgreementTab } from "@/components/cases/case-leave-agreement-tab";
import { CaseBillingTab } from "@/components/cases/case-billing-tab";
import { CaseCommentsTab } from "@/components/cases/case-comments-tab";
import { CaseEmailsTab } from "@/components/cases/case-emails-tab";
import { CaseSubscriptionHistory } from "@/components/cases/case-subscription-history";
import { CaseStatusTransitionDialog } from "@/components/cases/case-status-transition-dialog";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { useCase } from "@/hooks/use-cases";
import { toast } from "sonner";
import {
  VO_PURPOSE_LABELS,
  ENTITY_TYPE_LABELS,
  CASE_STATUS_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: caseData, loading, refetch } = useCase(id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    const res = await fetch(`/api/cases/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Case deleted");
      router.push("/cases");
    } else {
      const err = await res.json();
      toast.error(err.error || "Failed to delete case");
    }
    setDeleting(false);
    setDeleteOpen(false);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-2 gap-4 mt-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </div>
    );
  }

  if (!caseData) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Case not found</h2>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/cases")}>
          Back to Cases
        </Button>
      </div>
    );
  }

  const aggregator = caseData.aggregator as { id: string; name: string; code: string } | null;

  return (
    <div className="space-y-6">
      <PageBreadcrumb
        current={{ label: caseData.client_name }}
        fallbackParent={{ href: "/cases", label: "Cases" }}
      />
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/cases")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold">{caseData.client_name}</h1>
              <StatusBadge type="case_status" value={caseData.status} />
              <StatusBadge type="vo_purpose" value={caseData.purpose} />
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono">{caseData.case_number}</span>
              <span>|</span>
              {aggregator ? (
                <span>{aggregator.name}</span>
              ) : (
                <Badge variant="outline">Direct Client</Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => router.push(`/cases/${caseData.id}/edit`)}
          >
            <Edit2 className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => setStatusDialogOpen(true)}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Change Status
          </Button>
          {caseData.status === "intake_received" && (
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* Status Pipeline */}
      <CaseStatusPipeline
        currentStatus={caseData.status}
        proposalStatus={caseData.agreement?.status}
        agreementStatus={caseData.ll_agreement?.status}
        billingStatus={caseData.billing_statement}
      />

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
          <TabsTrigger value="proposal" className="flex items-center gap-1">Proposal <InfoTooltip text="Commercial offer with pricing and terms for this case" side="bottom" /></TabsTrigger>
          <TabsTrigger value="agreement" className="flex items-center gap-1">Agreement <InfoTooltip text="Formal Leave & License agreement with legal clauses and e-stamping" side="bottom" /></TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="comments">Comments</TabsTrigger>
          <TabsTrigger value="emails">Emails</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              {/* Client Info */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Client Information</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <InfoRow label="Name" value={caseData.client_name} />
                    <InfoRow label="Entity Type" value={ENTITY_TYPE_LABELS[caseData.client_entity_type]} />
                    <InfoRow icon={Building} label="Company" value={caseData.client_company_name} />
                    <InfoRow icon={Mail} label="Email" value={caseData.client_email} />
                    <InfoRow icon={Phone} label="Phone" value={caseData.client_phone} />
                    <InfoRow label="PAN" value={caseData.client_pan_number} />
                    <InfoRow label="GST" value={caseData.client_gst_number} />
                    <InfoRow label="CIN" value={caseData.client_cin_number} />
                    <InfoRow icon={User} label="Represented By" value={caseData.represented_by_name} />
                    <InfoRow label="Designation" value={caseData.represented_by_designation} />
                  </div>
                </CardContent>
              </Card>

              {/* Address */}
              {(caseData.client_address || caseData.client_city) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Client Address</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-start gap-2 text-sm">
                      <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
                      <p>
                        {[
                          caseData.client_address,
                          caseData.client_city,
                          caseData.client_state,
                          caseData.client_pincode,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Commercial */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Commercial Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground block text-xs">Monthly Rate</span>
                      <span className="font-semibold">{caseData.rate ? formatCurrency(caseData.rate) : "Not set"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-xs">Tenure</span>
                      <span>{caseData.tenure_months} months</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-xs">Start Date</span>
                      <span>{caseData.start_date ? formatDate(caseData.start_date) : "TBD"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block text-xs">Security Deposit</span>
                      <span>{caseData.security_deposit ? formatCurrency(caseData.security_deposit) : "None"}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Notes */}
              {caseData.notes && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Notes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm whitespace-pre-wrap">{caseData.notes}</p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Case Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Purpose</span>
                    <StatusBadge type="vo_purpose" value={caseData.purpose} />
                  </div>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status</span>
                    <StatusBadge type="case_status" value={caseData.status} />
                  </div>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Created</span>
                    <span>{formatDate(caseData.created_at)}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Updated</span>
                    <span>{formatDate(caseData.updated_at)}</span>
                  </div>
                  {caseData.activated_at && (
                    <>
                      <Separator />
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Activated</span>
                        <span>{formatDate(caseData.activated_at)}</span>
                      </div>
                    </>
                  )}
                  {caseData.renewal_due_at && (
                    <>
                      <Separator />
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Renewal Due</span>
                        <span>{formatDate(caseData.renewal_due_at)}</span>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* AI Metadata */}
              {(() => {
                const meta = caseData.metadata as Record<string, unknown> | null;
                if (!meta?.ai_parsed) return null;
                return (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">AI Parsing Info</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Confidence</span>
                        <span className="font-medium">
                          {Math.round(((meta.ai_confidence as number) || 0) * 100)}%
                        </span>
                      </div>
                      {Boolean(meta.needs_manual_review) && (
                        <div className="bg-yellow-50 text-yellow-800 text-xs p-2 rounded">
                          Needs manual review
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })()}

              {(caseData.tags ?? []).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Tags</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-1">
                      {(caseData.tags ?? []).map((tag) => (
                        <span
                          key={tag}
                          className="px-2 py-0.5 bg-muted rounded text-xs"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="subscriptions" className="mt-4">
          <CaseSubscriptionHistory caseId={id} />
        </TabsContent>

        <TabsContent value="documents" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Document Checklist</CardTitle>
            </CardHeader>
            <CardContent>
              <CaseDocumentsTab caseId={id} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="compliance" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Compliance Checks</CardTitle>
            </CardHeader>
            <CardContent>
              <CaseComplianceTab caseId={id} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="proposal" className="mt-4">
          <CaseAgreementTab caseId={id} />
        </TabsContent>

        <TabsContent value="agreement" className="mt-4">
          <CaseLeaveAgreementTab caseId={id} />
        </TabsContent>

        <TabsContent value="billing" className="mt-4">
          <CaseBillingTab caseId={id} />
        </TabsContent>

        <TabsContent value="comments" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Comments</CardTitle>
            </CardHeader>
            <CardContent>
              <CaseCommentsTab caseId={id} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="emails" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Email Trail</CardTitle>
            </CardHeader>
            <CardContent>
              <CaseEmailsTab caseId={id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Status Transition Dialog */}
      <CaseStatusTransitionDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        caseId={id}
        currentStatus={caseData.status}
        onSuccess={refetch}
      />

      {/* Delete Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Case</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete case {caseData.case_number} for {caseData.client_name}?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value?: string | null;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2">
      {Icon && <Icon className="h-4 w-4 mt-0.5 text-muted-foreground" />}
      <div>
        <p className="text-muted-foreground text-xs">{label}</p>
        <p>{value}</p>
      </div>
    </div>
  );
}
