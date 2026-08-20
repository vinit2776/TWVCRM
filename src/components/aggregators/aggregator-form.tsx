"use client";

import { useState } from "react";
import { useForm, useFieldArray, type FieldErrors, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
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
import { Switch } from "@/components/ui/switch";
import { createAggregatorSchema, updateAggregatorSchema, type CreateAggregatorInput } from "@/lib/validations";
import { preventEnterSubmit } from "@/lib/utils";
import type { Aggregator } from "@/types";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  AGGREGATOR_STATUSES,
  AGGREGATOR_STATUS_LABELS,
  AGGREGATOR_BILLING_METHODS,
  AGGREGATOR_BILLING_METHOD_LABELS,
} from "@/lib/constants";

interface AggregatorFormProps {
  aggregator?: Aggregator;
  onSubmit: (data: CreateAggregatorInput) => Promise<void>;
  onCancel: () => void;
}

export function AggregatorForm({ aggregator, onSubmit, onCancel }: AggregatorFormProps) {
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    control,
    formState: { errors },
  } = useForm<CreateAggregatorInput>({
    // Editing an existing (possibly legacy) aggregator must not re-enforce
    // create-time-only requirements like company_name — otherwise saving an
    // unrelated correction on an aggregator that predates that rule fails
    // validation before it even reaches the API.
    resolver: zodResolver(aggregator ? updateAggregatorSchema : createAggregatorSchema) as Resolver<CreateAggregatorInput>,
    defaultValues: {
      name: aggregator?.name || "",
      company_name: aggregator?.company_name || "",
      gst_number: aggregator?.gst_number || "",
      pan_number: aggregator?.pan_number || "",
      email_domain: aggregator?.email_domain || "",
      primary_email: aggregator?.primary_email || "",
      primary_phone: aggregator?.primary_phone || "",
      billing_address: aggregator?.billing_address || "",
      billing_city: aggregator?.billing_city || "",
      billing_state: aggregator?.billing_state || "",
      billing_pincode: aggregator?.billing_pincode || "",
      same_state_as_twv: aggregator?.same_state_as_twv ?? false,
      commission_percentage: aggregator?.commission_percentage ?? 0,
      billing_method: aggregator?.billing_method ?? "postpaid",
      // ?? undefined, never a bare null: an aggregator with no credit limit
      // stores null, and seeding the form with it made every such record
      // unsaveable — worse for a prepaid aggregator, where the Credit Limit
      // input isn't even rendered, so the error had nowhere to show.
      credit_limit: aggregator?.credit_limit ?? undefined,
      notes: aggregator?.notes || "",
      tags: aggregator?.tags || [],
      contacts: aggregator?.contacts?.map((c) => ({
        name: c.name,
        email: c.email || "",
        phone: c.phone || "",
        designation: c.designation || "",
        is_primary: c.is_primary,
      })) || [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "contacts",
  });

  const sameState = watch("same_state_as_twv");
  const billingMethod = watch("billing_method");

  // Without this, a schema error on a field the form doesn't render (or has
  // scrolled past) makes Save do nothing at all, with no message anywhere —
  // the user cannot tell a validation failure from a dead button.
  const onInvalid = (formErrors: FieldErrors<CreateAggregatorInput>) => {
    const [field, error] = Object.entries(formErrors)[0] ?? [];
    const message = (error as { message?: string } | undefined)?.message;
    toast.error(
      field
        ? `Could not save — ${field.replace(/_/g, " ")}: ${message ?? "invalid value"}`
        : "Could not save — please check the form for errors.",
    );
  };

  const onFormSubmit = async (data: CreateAggregatorInput) => {
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
    <form onSubmit={handleSubmit(onFormSubmit, onInvalid)} onKeyDown={preventEnterSubmit} className="space-y-6">
      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Aggregator Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="company_name">Company Name *</Label>
              <Input id="company_name" {...register("company_name")} />
              {errors.company_name && <p className="text-sm text-red-500">{errors.company_name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" {...register("name")} placeholder="e.g. ABC Associates" />
              {errors.name && <p className="text-sm text-red-500">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="gst_number">GST Number</Label>
              <Input id="gst_number" {...register("gst_number")} placeholder="22XXXXX1234X1Z5" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pan_number">PAN Number</Label>
              <Input id="pan_number" {...register("pan_number")} placeholder="XXXXX1234X" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email_domain">Email Domain</Label>
              <Input id="email_domain" {...register("email_domain")} placeholder="e.g. abcassociates.com" />
              <p className="text-xs text-muted-foreground">Used for auto-matching inbound emails</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="primary_email">Primary Email</Label>
              <Input id="primary_email" type="email" {...register("primary_email")} />
              {errors.primary_email && <p className="text-sm text-red-500">{errors.primary_email.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="primary_phone">Primary Phone</Label>
              <Input id="primary_phone" {...register("primary_phone")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="commission_percentage">Commission %</Label>
              <Input
                id="commission_percentage"
                type="number"
                step="0.1"
                {...register("commission_percentage", {
                  setValueAs: (v) => (v === "" || v === null ? undefined : Number(v)),
                })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billing_method">Billing Method</Label>
              <Select
                value={billingMethod}
                onValueChange={(value) => setValue("billing_method", value as "postpaid" | "prepaid")}
              >
                <SelectTrigger id="billing_method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGGREGATOR_BILLING_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {AGGREGATOR_BILLING_METHOD_LABELS[method]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {billingMethod === "prepaid"
                  ? "Each case requires an approved Payment Proof document before its Leave & License Agreement can be executed."
                  : "Referrals accumulate and are invoiced monthly or ad-hoc."}
              </p>
            </div>
            {billingMethod === "postpaid" && (
              <div className="space-y-2">
                <Label htmlFor="credit_limit">Credit Limit</Label>
                <Input
                  id="credit_limit"
                  type="number"
                  step="1"
                  placeholder="No limit"
                  {...register("credit_limit", {
                    setValueAs: (v) => (v === "" || v === null ? undefined : Number(v)),
                  })}
                />
                <p className="text-xs text-muted-foreground">
                  Advisory only — shows a warning when outstanding unbilled amount exceeds this. Leave blank for no limit.
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id="same_state"
              checked={sameState}
              onCheckedChange={(checked) => setValue("same_state_as_twv", checked)}
            />
            <Label htmlFor="same_state" className="cursor-pointer">
              Same state as TWV (Tamil Nadu) — affects GST calculation (CGST+SGST vs IGST)
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* Billing Address */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Billing Address</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2 space-y-2">
              <Label htmlFor="billing_address">Address</Label>
              <Textarea id="billing_address" {...register("billing_address")} rows={2} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billing_city">City</Label>
              <Input id="billing_city" {...register("billing_city")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billing_state">State</Label>
              <Input id="billing_state" {...register("billing_state")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billing_pincode">Pincode</Label>
              <Input id="billing_pincode" {...register("billing_pincode")} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Contacts */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Contacts</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ name: "", email: "", phone: "", designation: "", is_primary: false })}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Contact
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No contacts added yet. Click &quot;Add Contact&quot; to add one.
            </p>
          )}
          {fields.map((field, index) => (
            <div key={field.id} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Contact {index + 1}</span>
                <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Name *</Label>
                  <Input {...register(`contacts.${index}.name`)} placeholder="Contact name" />
                </div>
                <div className="space-y-1">
                  <Label>Email</Label>
                  <Input {...register(`contacts.${index}.email`)} type="email" />
                </div>
                <div className="space-y-1">
                  <Label>Phone</Label>
                  <Input {...register(`contacts.${index}.phone`)} />
                </div>
                <div className="space-y-1">
                  <Label>Designation</Label>
                  <Input {...register(`contacts.${index}.designation`)} placeholder="e.g. Partner" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={watch(`contacts.${index}.is_primary`)}
                  onCheckedChange={(checked) => setValue(`contacts.${index}.is_primary`, checked)}
                />
                <Label className="text-sm">Primary Contact</Label>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Notes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Additional Notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea {...register("notes")} rows={3} placeholder="Any additional notes about this aggregator..." />
          <p className="text-xs text-muted-foreground">
            Internal only — never shown to the aggregator.
          </p>
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {aggregator ? "Update Aggregator" : "Create Aggregator"}
        </Button>
      </div>
    </form>
  );
}
