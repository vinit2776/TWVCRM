"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Trash2,
  Pencil,
  Mail,
  Phone,
  Globe,
  Building,
  MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { useAggregator } from "@/hooks/use-aggregators";
import { AggregatorContactsTab } from "@/components/aggregators/aggregator-contacts-tab";
import { AggregatorRateCardsTab } from "@/components/aggregators/aggregator-rate-cards-tab";
import { AggregatorBillingTab } from "@/components/aggregators/aggregator-billing-tab";
import { AggregatorForm } from "@/components/aggregators/aggregator-form";
import { toast } from "sonner";
import { formatDate, formatCurrency } from "@/lib/utils";
import { AGGREGATOR_BILLING_METHOD_LABELS } from "@/lib/constants";
import type { CreateAggregatorInput } from "@/lib/validations";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function AggregatorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: aggregator, loading, refetch } = useAggregator(id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    const res = await fetch(`/api/aggregators/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Aggregator deleted");
      router.push("/aggregators");
    } else {
      toast.error("Failed to delete aggregator");
    }
    setDeleting(false);
    setDeleteOpen(false);
  };

  const handleEditSubmit = async (data: CreateAggregatorInput) => {
    const { contacts: _contacts, ...updateData } = data;
    void _contacts; // contacts are managed separately via the Contacts tab
    const res = await fetch(`/api/aggregators/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updateData),
    });
    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error || "Failed to update aggregator");
      throw new Error(err.error || "Failed to update aggregator");
    }
    toast.success("Aggregator updated");
    setEditOpen(false);
    refetch();
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <div className="grid grid-cols-2 gap-4 mt-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </div>
    );
  }

  if (!aggregator) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Aggregator not found</h2>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/aggregators")}>
          Back to Aggregators
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageBreadcrumb
        current={{ label: aggregator.name }}
        fallbackParent={{ href: "/aggregators", label: "Aggregators" }}
      />
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/aggregators")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{aggregator.name}</h1>
              <StatusBadge type="aggregator_status" value={aggregator.status} />
            </div>
            <p className="text-sm text-muted-foreground font-mono">{aggregator.code}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="rate-cards">Rate Cards</TabsTrigger>
          {aggregator.billing_method === "postpaid" && (
            <TabsTrigger value="billing">Billing</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="overview" className="space-y-6 mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              {/* Aggregator Info */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Aggregator Information</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <InfoRow icon={Building} label="Company" value={aggregator.company_name} />
                    <InfoRow icon={Mail} label="Email" value={aggregator.primary_email} />
                    <InfoRow icon={Phone} label="Phone" value={aggregator.primary_phone} />
                    <InfoRow icon={Globe} label="Email Domain" value={aggregator.email_domain} />
                    <InfoRow label="GST Number" value={aggregator.gst_number} />
                    <InfoRow label="PAN Number" value={aggregator.pan_number} />
                    <InfoRow label="Commission" value={aggregator.commission_percentage ? `${aggregator.commission_percentage}%` : undefined} />
                    <InfoRow label="GST Type" value={aggregator.same_state_as_twv ? "Intra-state (CGST+SGST)" : "Inter-state (IGST)"} />
                    <InfoRow label="Billing Method" value={AGGREGATOR_BILLING_METHOD_LABELS[aggregator.billing_method]} />
                    {aggregator.billing_method === "postpaid" && (
                      <InfoRow label="Credit Limit" value={aggregator.credit_limit ? formatCurrency(aggregator.credit_limit) : "No limit"} />
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Billing Address */}
              {(aggregator.billing_address || aggregator.billing_city) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Billing Address</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-start gap-2 text-sm">
                      <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
                      <p>
                        {[
                          aggregator.billing_address,
                          aggregator.billing_city,
                          aggregator.billing_state,
                          aggregator.billing_pincode,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Notes */}
              {aggregator.notes && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Notes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm whitespace-pre-wrap">{aggregator.notes}</p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Quick Info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Created</span>
                    <span>{formatDate(aggregator.created_at)}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Updated</span>
                    <span>{formatDate(aggregator.updated_at)}</span>
                  </div>
                </CardContent>
              </Card>

              {(aggregator.tags ?? []).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Tags</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-1">
                      {(aggregator.tags ?? []).map((tag) => (
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

        <TabsContent value="contacts" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contacts</CardTitle>
            </CardHeader>
            <CardContent>
              <AggregatorContactsTab
                aggregatorId={id}
                contacts={aggregator.contacts}
                onRefresh={refetch}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rate-cards" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Rate Cards</CardTitle>
            </CardHeader>
            <CardContent>
              <AggregatorRateCardsTab aggregatorId={id} />
            </CardContent>
          </Card>
        </TabsContent>

        {aggregator.billing_method === "postpaid" && (
          <TabsContent value="billing" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Billing</CardTitle>
              </CardHeader>
              <CardContent>
                <AggregatorBillingTab
                  aggregatorId={id}
                  creditLimit={aggregator.credit_limit}
                  primaryEmail={aggregator.primary_email}
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Aggregator</DialogTitle>
          </DialogHeader>
          <AggregatorForm
            aggregator={aggregator}
            onSubmit={handleEditSubmit}
            onCancel={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Aggregator</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {aggregator.name}?
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
