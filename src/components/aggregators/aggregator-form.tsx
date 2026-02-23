"use client";

import { useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
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
import { Switch } from "@/components/ui/switch";
import { createAggregatorSchema, type CreateAggregatorInput } from "@/lib/validations";
import type { Aggregator } from "@/types";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { AGGREGATOR_STATUSES, AGGREGATOR_STATUS_LABELS } from "@/lib/constants";

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
    resolver: zodResolver(createAggregatorSchema),
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
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-6">
      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Aggregator Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" {...register("name")} placeholder="e.g. ABC Associates" />
              {errors.name && <p className="text-sm text-red-500">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="company_name">Company Name</Label>
              <Input id="company_name" {...register("company_name")} />
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
                {...register("commission_percentage", { valueAsNumber: true })}
              />
            </div>
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
        <CardContent>
          <Textarea {...register("notes")} rows={3} placeholder="Any additional notes about this aggregator..." />
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
