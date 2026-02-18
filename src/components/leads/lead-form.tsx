"use client";

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
import { createLeadSchema, type CreateLeadInput } from "@/lib/validations";
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  WORKSPACE_TYPES,
  WORKSPACE_TYPE_LABELS,
  RATINGS,
  RATING_LABELS,
} from "@/lib/constants";
import type { Lead } from "@/types";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { LocationSelector } from "@/components/shared/location-selector";

interface LeadFormProps {
  lead?: Lead;
  onSubmit: (data: CreateLeadInput) => Promise<void>;
  onCancel: () => void;
}

export function LeadForm({ lead, onSubmit, onCancel }: LeadFormProps) {
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateLeadInput>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: {
      first_name: lead?.first_name || "",
      last_name: lead?.last_name || "",
      company: lead?.company || "",
      aggregator_contact_name: lead?.aggregator_contact_name || "",
      email: lead?.email || "",
      phone: lead?.phone || "",
      mobile: lead?.mobile || "",
      website: lead?.website || "",
      title: lead?.title || "",
      secondary_email: lead?.secondary_email || "",
      status: lead?.status || "new",
      source: lead?.source || "online_form",
      industry: lead?.industry || "",
      no_of_employees: lead?.no_of_employees || undefined,
      rating: lead?.rating || "none",
      score: lead?.score || 0,
      workspace_type: lead?.workspace_type || undefined,
      seat_capacity: lead?.seat_capacity || undefined,
      preferred_location: lead?.preferred_location || "",
      location_id: lead?.location_id || "",
      working_hours: lead?.working_hours || "",
      budget_per_seat: lead?.budget_per_seat || undefined,
      street: lead?.street || "",
      city: lead?.city || "",
      state: lead?.state || "",
      zip_code: lead?.zip_code || "",
      country: lead?.country || "India",
      enquiry_form_google: lead?.enquiry_form_google || "",
      enquiry_form_direct: lead?.enquiry_form_direct || "",
      description: lead?.description || "",
      tags: lead?.tags || [],
    },
  });

  const status = watch("status");
  const source = watch("source");
  const rating = watch("rating");
  const workspaceType = watch("workspace_type");

  const onFormSubmit = async (data: CreateLeadInput) => {
    setSubmitting(true);
    try {
      await onSubmit(data);
    } finally {
      setSubmitting(false);
    }
  };

  // Log validation errors for debugging
  const onFormError = (formErrors: Record<string, unknown>) => {
    console.error("Form validation errors:", formErrors);
  };

  return (
    <form onSubmit={handleSubmit(onFormSubmit, onFormError)} className="space-y-8">
      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2 sticky top-0 bg-background z-10 pb-4 border-b">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {lead ? "Update Lead" : "Create Lead"}
        </Button>
      </div>

      {/* Lead Information */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Lead Information
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="first_name">
              First Name <span className="text-destructive">*</span>
            </Label>
            <Input id="first_name" {...register("first_name")} />
            {errors.first_name && (
              <p className="text-xs text-destructive">
                {errors.first_name.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="last_name">
              Last Name <span className="text-destructive">*</span>
            </Label>
            <Input id="last_name" {...register("last_name")} />
            {errors.last_name && (
              <p className="text-xs text-destructive">
                {errors.last_name.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="company">Company</Label>
            <Input id="company" {...register("company")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input id="title" {...register("title")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" {...register("email")} />
            {errors.email && (
              <p className="text-xs text-destructive">
                {errors.email.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="secondary_email">Secondary Email</Label>
            <Input
              id="secondary_email"
              type="email"
              {...register("secondary_email")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input id="phone" {...register("phone")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mobile">Mobile</Label>
            <Input id="mobile" {...register("mobile")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="website">Website</Label>
            <Input id="website" {...register("website")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="aggregator_contact_name">
              Aggregator Contact Person
            </Label>
            <Input
              id="aggregator_contact_name"
              {...register("aggregator_contact_name")}
            />
          </div>
          <div className="space-y-2">
            <Label>Lead Status</Label>
            <Select
              value={status}
              onValueChange={(val) =>
                setValue("status", val as CreateLeadInput["status"])
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAD_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {LEAD_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Lead Source</Label>
            <Select
              value={source}
              onValueChange={(val) =>
                setValue("source", val as CreateLeadInput["source"])
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAD_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {LEAD_SOURCE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Rating</Label>
            <Select
              value={rating}
              onValueChange={(val) =>
                setValue("rating", val as CreateLeadInput["rating"])
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RATINGS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {RATING_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="score">Score (0-100)</Label>
            <Input
              id="score"
              type="number"
              min={0}
              max={100}
              {...register("score", { setValueAs: (v: string) => v === "" ? 0 : Number(v) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="industry">Industry</Label>
            <Input id="industry" {...register("industry")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="no_of_employees">No. of Employees</Label>
            <Input
              id="no_of_employees"
              type="number"
              {...register("no_of_employees", { setValueAs: (v: string) => v === "" ? undefined : Number(v) })}
            />
          </div>
        </div>
      </section>

      {/* Coworking Information */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Coworking Requirements
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Workspace Type</Label>
            <Select
              value={workspaceType || ""}
              onValueChange={(val) =>
                setValue(
                  "workspace_type",
                  val as CreateLeadInput["workspace_type"]
                )
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select workspace type" />
              </SelectTrigger>
              <SelectContent>
                {WORKSPACE_TYPES.map((w) => (
                  <SelectItem key={w} value={w}>
                    {WORKSPACE_TYPE_LABELS[w]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="seat_capacity">Seat Capacity</Label>
            <Input
              id="seat_capacity"
              type="number"
              {...register("seat_capacity", { setValueAs: (v: string) => v === "" ? undefined : Number(v) })}
            />
          </div>
          <div className="space-y-2">
            <Label>Preferred Location</Label>
            <LocationSelector
              value={watch("location_id") || null}
              onValueChange={(id) => setValue("location_id", id || "")}
              placeholder="Select center"
            />
            {lead?.preferred_location && !lead?.location_id && (
              <p className="text-xs text-muted-foreground">Legacy: {lead.preferred_location}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="working_hours">Working Hours/Shift Timings</Label>
            <Input id="working_hours" {...register("working_hours")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="budget_per_seat">Budget Per Seat (Monthly)</Label>
            <Input
              id="budget_per_seat"
              type="number"
              {...register("budget_per_seat", { setValueAs: (v: string) => v === "" ? undefined : Number(v) })}
            />
          </div>
        </div>
      </section>

      {/* Address Information */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Address Information
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="street">Street</Label>
            <Input id="street" {...register("street")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">City</Label>
            <Input id="city" {...register("city")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="state">State</Label>
            <Input id="state" {...register("state")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="zip_code">Zip Code</Label>
            <Input id="zip_code" {...register("zip_code")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="country">Country</Label>
            <Input id="country" {...register("country")} />
          </div>
        </div>
      </section>

      {/* Links */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Links
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="enquiry_form_google">
              Enquiry Form - Google
            </Label>
            <Input
              id="enquiry_form_google"
              {...register("enquiry_form_google")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="enquiry_form_direct">
              Enquiry Form - Direct/Walk-in
            </Label>
            <Input
              id="enquiry_form_direct"
              {...register("enquiry_form_direct")}
            />
          </div>
        </div>
      </section>

      {/* Description */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Description
        </h3>
        <Textarea
          {...register("description")}
          placeholder="Add notes about this lead..."
          rows={4}
        />
      </section>
    </form>
  );
}
