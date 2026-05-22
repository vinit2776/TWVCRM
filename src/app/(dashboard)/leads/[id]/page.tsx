"use client";

import { use, useState, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Edit2,
  Trash2,
  Phone,
  Mail,
  Globe,
  MapPin,
  Building,
  Briefcase,
  Star,
  Plus,
  Printer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { StatusBadge, RatingBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { useLead } from "@/hooks/use-leads";
import { toast } from "sonner";
import {
  LEAD_SOURCE_LABELS,
  WORKSPACE_TYPE_LABELS,
  LEAD_SCORE_SHORT_LABELS,
  ENTITY_TYPE_LABELS,
  DOCUMENT_CHECKLISTS,
  VO_PURPOSE_LABELS,
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
import { LeadTimeline } from "@/components/activities/lead-timeline";
import { ActivityForm } from "@/components/activities/activity-form";
import { LeadProposalsTab } from "@/components/leads/lead-proposals-tab";
import { LeadContractsTab } from "@/components/leads/lead-contracts-tab";
import { LeadDocumentsTab } from "@/components/leads/lead-documents-tab";
import { LeadCreditsCard } from "@/components/leads/lead-credits-card";
import { LeadCautionsBanner } from "@/components/leads/lead-cautions-banner";
import dynamic from "next/dynamic";
const LeadBillingSnippet = dynamic(
  () => import("@/components/leads/lead-billing-snippet").then((m) => m.LeadBillingSnippet),
  { ssr: false }
);
import { LeadTasksTab } from "@/components/leads/lead-tasks-tab";
import { LeadFeedbacksTab } from "@/components/leads/lead-feedbacks-tab";
import { LeadLifecycle } from "@/components/leads/lead-lifecycle";
import { LeadContactsPanel } from "@/components/leads/lead-contacts-panel";
import { ManualPrintEntryDialog } from "@/components/accounting/manual-print-entry-dialog";

export default function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") ?? "overview";
  const highlightActivityId = searchParams.get("highlight") ?? undefined;
  const { data: lead, loading } = useLead(id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activityFormOpen, setActivityFormOpen] = useState(false);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [printEntryOpen, setPrintEntryOpen] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);

  // Fetch current user role for conditional rendering
  useEffect(() => {
    fetch("/api/me")
      .then(r => r.json())
      .then(j => setUserRole(j.role ?? null))
      .catch(() => null);
  }, []);

  const handleActivitySuccess = useCallback(() => {
    setActivityRefreshKey((k) => k + 1);
  }, []);

  const handleDelete = async () => {
    setDeleting(true);
    const res = await fetch(`/api/leads/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Lead deleted successfully");
      router.push("/leads");
    } else {
      toast.error("Failed to delete lead");
    }
    setDeleting(false);
    setDeleteOpen(false);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <div className="grid grid-cols-2 gap-4 mt-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Lead not found</h2>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/leads")}>
          Back to Leads
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/leads")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">
                {lead.first_name} {lead.last_name}
              </h1>
              <StatusBadge type="lead_status" value={lead.status} />
              <RatingBadge rating={lead.rating} />
            </div>
            {lead.company && (
              <p className="text-sm text-muted-foreground">{lead.company}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Log Print Usage — only for roles that can record print usage */}
          {["admin", "accounts", "manager"].includes(userRole ?? "") && (
            <Button variant="outline" onClick={() => setPrintEntryOpen(true)}>
              <Printer className="mr-2 h-4 w-4" />
              Log Print Usage
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => router.push(`/leads/${id}/edit`)}
          >
            <Edit2 className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <Tabs defaultValue={initialTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activities">Activities</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
          <TabsTrigger value="contracts">Contracts</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 mt-4">
          {/* Cautions banner — surfaced at the very top of the overview
              tab, before any lead details, because it affects how staff
              interacts with this customer. Auto-hides if no active
              cautions exist. */}
          <LeadCautionsBanner leadId={lead.id} mode="profile" />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main info */}
            <div className="lg:col-span-2 space-y-6">
              {/* Lead Information */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Lead Information</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <InfoRow
                      icon={Mail}
                      label="Email"
                      value={lead.email}
                    />
                    <InfoRow
                      icon={Mail}
                      label="Secondary Email"
                      value={lead.secondary_email}
                    />
                    <InfoRow
                      icon={Phone}
                      label="Phone"
                      value={lead.phone}
                    />
                    <InfoRow
                      icon={Phone}
                      label="Mobile"
                      value={lead.mobile}
                    />
                    <InfoRow
                      icon={Globe}
                      label="Website"
                      value={lead.website}
                    />
                    <InfoRow
                      icon={Briefcase}
                      label="Title"
                      value={lead.title}
                    />
                    <InfoRow
                      icon={Building}
                      label="Industry"
                      value={lead.industry}
                    />
                    <InfoRow
                      label="No. of Employees"
                      value={lead.no_of_employees?.toString()}
                    />
                    <InfoRow
                      label="Lead Source"
                      value={LEAD_SOURCE_LABELS[lead.source]}
                    />
                    <InfoRow
                      icon={Star}
                      label="Score"
                      value={LEAD_SCORE_SHORT_LABELS[lead.score] || `${lead.score}/100`}
                    />
                    <InfoRow
                      label="Aggregator Contact"
                      value={lead.aggregator_contact_name}
                    />
                    {lead.assigned_user && (
                      <InfoRow
                        label="Assigned To"
                        value={lead.assigned_user.full_name}
                      />
                    )}
                    <InfoRow
                      icon={Building}
                      label="Entity Type"
                      value={lead.entity_type ? ENTITY_TYPE_LABELS[lead.entity_type] : undefined}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Contacts — multiple contact points per lead */}
              <LeadContactsPanel leadId={lead.id} />

              {/* KYC Document Requirements Preview */}
              {lead.entity_type && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      KYC Documents Required — {ENTITY_TYPE_LABELS[lead.entity_type]}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {Object.entries(DOCUMENT_CHECKLISTS).map(([purpose, entityMap]) => {
                      const docs = entityMap[lead.entity_type!];
                      if (!docs || docs.length === 0) return null;
                      return (
                        <div key={purpose}>
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                            {VO_PURPOSE_LABELS[purpose] || purpose}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {docs.map((doc) => (
                              <span
                                key={doc.type}
                                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                  doc.required
                                    ? "bg-primary/10 text-primary"
                                    : "bg-muted text-muted-foreground"
                                }`}
                              >
                                {doc.label}
                                {!doc.required && (
                                  <span className="ml-1 text-[10px] opacity-60">
                                    (optional)
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    <p className="text-xs text-muted-foreground mt-2">
                      These documents will be required when creating a case for this client.
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* Coworking Requirements */}
              {(lead.workspace_type ||
                lead.seat_capacity ||
                lead.budget_per_seat) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Coworking Requirements
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                      <InfoRow
                        label="Workspace Type"
                        value={
                          lead.workspace_type
                            ? WORKSPACE_TYPE_LABELS[lead.workspace_type]
                            : undefined
                        }
                      />
                      <InfoRow
                        label="Seat Capacity"
                        value={lead.seat_capacity?.toString()}
                      />
                      <InfoRow
                        label="Location"
                        value={lead.location?.name || lead.preferred_location}
                      />
                      <InfoRow
                        label="Working Hours"
                        value={lead.working_hours}
                      />
                      <InfoRow
                        label="Budget Per Seat"
                        value={
                          lead.budget_per_seat
                            ? formatCurrency(lead.budget_per_seat)
                            : undefined
                        }
                      />
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Address */}
              {(lead.street || lead.city || lead.state) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Address</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-start gap-2 text-sm">
                      <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
                      <p>
                        {[
                          lead.street,
                          lead.city,
                          lead.state,
                          lead.zip_code,
                          lead.country,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Description */}
              {lead.description && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Description</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm whitespace-pre-wrap">
                      {lead.description}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-4">
              {/* Lead Journey — visual lifecycle stepper */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Lead Journey</CardTitle>
                </CardHeader>
                <CardContent>
                  <LeadLifecycle lead={lead} />
                  <Separator className="my-3" />
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <span>Last updated</span>
                      <span>{formatDate(lead.updated_at)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Time Credits — partial-checkout carry-forward (auto-hides
                  when the lead has no credits in any state) */}
              <LeadCreditsCard leadId={lead.id} />

              {/* Tags */}
              {(lead.tags ?? []).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Tags</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-1">
                      {(lead.tags ?? []).map((tag) => (
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

              {/* Links */}
              {(lead.enquiry_form_google || lead.enquiry_form_direct) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Links</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {lead.enquiry_form_google && (
                      <div>
                        <span className="text-muted-foreground block">
                          Google Enquiry
                        </span>
                        <a
                          href={lead.enquiry_form_google}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline break-all"
                        >
                          {lead.enquiry_form_google}
                        </a>
                      </div>
                    )}
                    {lead.enquiry_form_direct && (
                      <div>
                        <span className="text-muted-foreground block">
                          Direct Enquiry
                        </span>
                        <a
                          href={lead.enquiry_form_direct}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline break-all"
                        >
                          {lead.enquiry_form_direct}
                        </a>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="activities" className="mt-4 space-y-4">
          {/* Billing snapshot — sits above the timeline so finance /
              sales sees lifetime money this customer has paid before
              digging into individual activities. Filter toggles
              between lifetime and current Indian financial year;
              line graph shows monthly revenue trend. Auto-hides
              gracefully when there are no payments. */}
          <LeadBillingSnippet leadId={id} />

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Lead Timeline</CardTitle>
              <Button size="sm" onClick={() => setActivityFormOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Log Activity
              </Button>
            </CardHeader>
            <CardContent>
              <LeadTimeline
                key={activityRefreshKey}
                leadId={id}
                lead={lead}
                highlightId={highlightActivityId}
              />
            </CardContent>
          </Card>
          <ActivityForm
            leadId={id}
            open={activityFormOpen}
            onOpenChange={setActivityFormOpen}
            onSuccess={handleActivitySuccess}
          />
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          <LeadTasksTab
            leadId={id}
            leadName={`${lead.first_name} ${lead.last_name}`}
          />
        </TabsContent>

        <TabsContent value="proposals" className="mt-4">
          <LeadProposalsTab leadId={id} leadLocationId={lead?.location_id} />
        </TabsContent>

        <TabsContent value="contracts" className="mt-4">
          <LeadContractsTab leadId={id} />
        </TabsContent>

        <TabsContent value="documents" className="mt-4">
          <LeadDocumentsTab leadId={id} />
        </TabsContent>

        <TabsContent value="feedback" className="mt-4">
          <LeadFeedbacksTab leadId={id} />
        </TabsContent>
      </Tabs>

      {/* Print Usage Dialog — scoped to this lead's active contracts.
          If the lead has one active contract the dropdown is pre-filtered
          to it; if they have multiple locations the user selects from that
          shorter list rather than every contract in the system. */}
      <ManualPrintEntryDialog
        open={printEntryOpen}
        onOpenChange={setPrintEntryOpen}
        filterLeadId={id}
      />

      {/* Delete Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Lead</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {lead.first_name} {lead.last_name}?
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
  value?: string;
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
