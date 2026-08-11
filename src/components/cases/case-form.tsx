"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createCaseSchema, type CreateCaseInput } from "@/lib/validations";
import {
  VO_PURPOSES,
  VO_PURPOSE_LABELS,
  ENTITY_TYPES,
  ENTITY_TYPE_LABELS,
} from "@/lib/constants";
import type { Aggregator, VoCase } from "@/types";
import { Loader2 } from "lucide-react";
import { LocationSelector } from "@/components/shared/location-selector";
import { preventEnterSubmit } from "@/lib/utils";

interface CaseFormProps {
  caseData?: VoCase;
  onSubmit: (data: CreateCaseInput) => Promise<void>;
  onCancel: () => void;
}

export function CaseForm({ caseData, onSubmit, onCancel }: CaseFormProps) {
  const [submitting, setSubmitting] = useState(false);
  const [aggregators, setAggregators] = useState<{ id: string; name: string; code: string }[]>([]);

  useEffect(() => {
    fetch("/api/aggregators?limit=100&status=active")
      .then((res) => res.json())
      .then((json) => setAggregators(json.data || []))
      .catch(() => {});
  }, []);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateCaseInput>({
    resolver: zodResolver(createCaseSchema),
    defaultValues: {
      case_source: caseData?.case_source || "aggregator",
      aggregator_id: caseData?.aggregator_id || "",
      purpose: caseData?.purpose || "gst_registration",
      client_name: caseData?.client_name || "",
      client_entity_type: caseData?.client_entity_type || "individual",
      client_company_name: caseData?.client_company_name || "",
      client_gst_number: caseData?.client_gst_number || "",
      client_pan_number: caseData?.client_pan_number || "",
      client_cin_number: caseData?.client_cin_number || "",
      client_email: caseData?.client_email || "",
      client_phone: caseData?.client_phone || "",
      client_address: caseData?.client_address || "",
      client_city: caseData?.client_city || "",
      client_state: caseData?.client_state || "",
      client_pincode: caseData?.client_pincode || "",
      rate: caseData?.rate || undefined,
      tenure_months: caseData?.tenure_months || 12,
      start_date: caseData?.start_date || "",
      security_deposit: caseData?.security_deposit || 0,
      location_id: caseData?.location_id || "",
      notes: caseData?.notes || "",
      tags: caseData?.tags || [],
    },
  });

  const caseSource = watch("case_source");
  const entityType = watch("client_entity_type");
  const purpose = watch("purpose");
  const startDate = watch("start_date");
  const tenureMonths = watch("tenure_months");
  const showCompanyFields = entityType && !["individual", "proprietorship"].includes(entityType);

  // Calculate end date from start date + tenure
  const endDate = (() => {
    if (!startDate || !tenureMonths) return "";
    const d = new Date(startDate);
    d.setMonth(d.getMonth() + tenureMonths);
    d.setDate(d.getDate() - 1); // end date is last day of tenure
    return d.toISOString().split("T")[0];
  })();

  const onFormSubmit = async (data: CreateCaseInput) => {
    setSubmitting(true);
    try {
      await onSubmit(data);
    } catch {
      // error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} onKeyDown={preventEnterSubmit} className="space-y-6">
      {/* Aggregator + Purpose */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Case Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Referral Source *</Label>
              <Select
                value={caseSource}
                onValueChange={(val) => {
                  setValue("case_source", val as CreateCaseInput["case_source"]);
                  if (val === "direct") {
                    setValue("aggregator_id", "");
                    setValue("aggregator_contact_id", "");
                  }
                }}
                disabled={!!caseData}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="aggregator">Aggregator</SelectItem>
                  <SelectItem value="direct">Direct Client</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {caseSource === "aggregator" && (
              <div className="space-y-2">
                <Label>Aggregator *</Label>
                <Select
                  value={watch("aggregator_id")}
                  onValueChange={(val) => setValue("aggregator_id", val)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select aggregator" />
                  </SelectTrigger>
                  <SelectContent>
                    {aggregators.map((agg) => (
                      <SelectItem key={agg.id} value={agg.id}>
                        {agg.name} ({agg.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.aggregator_id && (
                  <p className="text-sm text-red-500">{errors.aggregator_id.message}</p>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label>Purpose *</Label>
              <Select
                value={watch("purpose")}
                onValueChange={(val) => setValue("purpose", val as CreateCaseInput["purpose"])}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select purpose" />
                </SelectTrigger>
                <SelectContent>
                  {VO_PURPOSES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {VO_PURPOSE_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Location</Label>
              <LocationSelector
                value={watch("location_id") || null}
                onValueChange={(id) => setValue("location_id", id || "")}
                includeAllOption
                placeholder="Select location"
              />
            </div>
            <div className="space-y-2">
              <Label>Entity Type *</Label>
              <Select
                value={watch("client_entity_type")}
                onValueChange={(val) => setValue("client_entity_type", val as CreateCaseInput["client_entity_type"])}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select entity type" />
                </SelectTrigger>
                <SelectContent>
                  {ENTITY_TYPES.map((e) => (
                    <SelectItem key={e} value={e}>
                      {ENTITY_TYPE_LABELS[e]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Client Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Client Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Client Name *</Label>
              <Input {...register("client_name")} placeholder="Full name" />
              {errors.client_name && <p className="text-sm text-red-500">{errors.client_name.message}</p>}
            </div>
            {showCompanyFields && (
              <div className="space-y-2">
                <Label>Company Name</Label>
                <Input {...register("client_company_name")} />
              </div>
            )}
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" {...register("client_email")} />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input {...register("client_phone")} />
            </div>
            <div className="space-y-2">
              <Label>PAN Number</Label>
              <Input {...register("client_pan_number")} placeholder="XXXXX1234X" />
            </div>
            <div className="space-y-2">
              <Label>GST Number</Label>
              <Input {...register("client_gst_number")} />
            </div>
            {showCompanyFields && (
              <div className="space-y-2">
                <Label>CIN Number</Label>
                <Input {...register("client_cin_number")} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Client Address */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Client Address</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2 space-y-2">
              <Label>Address</Label>
              <Textarea {...register("client_address")} rows={2} />
            </div>
            <div className="space-y-2">
              <Label>City</Label>
              <Input {...register("client_city")} />
            </div>
            <div className="space-y-2">
              <Label>State</Label>
              <Input {...register("client_state")} />
            </div>
            <div className="space-y-2">
              <Label>Pincode</Label>
              <Input {...register("client_pincode")} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Commercial */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Commercial Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Monthly Rate (INR) {caseSource === "direct" && "*"}</Label>
              <Input
                type="number"
                {...register("rate", { valueAsNumber: true })}
                placeholder={caseSource === "direct" ? "Required — no rate card for direct clients" : "Auto-fills from rate card if blank"}
              />
              {caseSource === "aggregator" ? (
                <p className="text-xs text-muted-foreground">Leave blank to use aggregator rate card</p>
              ) : (
                errors.rate && <p className="text-sm text-red-500">{errors.rate.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Tenure (months)</Label>
              <Input type="number" {...register("tenure_months", { valueAsNumber: true })} />
            </div>
            <div className="space-y-2">
              <Label>Start Date</Label>
              <Input type="date" {...register("start_date")} />
            </div>
            <div className="space-y-2">
              <Label>End Date</Label>
              <Input type="date" value={endDate} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">Auto-calculated from start date + tenure</p>
            </div>
            <div className="space-y-2">
              <Label>Security Deposit (INR)</Label>
              <Input type="number" {...register("security_deposit", { valueAsNumber: true })} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Notes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea {...register("notes")} rows={3} placeholder="Additional notes..." />
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {caseData ? "Update Case" : "Create Case"}
        </Button>
      </div>
    </form>
  );
}
