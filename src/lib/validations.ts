import { z } from "zod";
import { ACCOUNTING_HEADS } from "@/lib/constants";

export function zodErrorResponse<T>(error: z.ZodError<T>): { error: string; details: Record<string, string[] | undefined> } {
  const fieldErrors = error.flatten().fieldErrors as Record<string, string[] | undefined>;
  const message = Object.entries(fieldErrors)
    .map(([field, errs]) => `${field}: ${(errs ?? []).join(", ")}`)
    .join("; ") || "Invalid request";
  return { error: message, details: fieldErrors };
}

// ==========================================
// Lead Validations
// ==========================================
export const createLeadSchema = z.object({
  first_name: z.string().min(1, "First name is required"),
  last_name: z.string().optional(),
  company: z.string().optional(),
  aggregator_contact_name: z.string().optional(),
  email: z.string().email("Invalid email address").optional().or(z.literal("")),
  phone: z.string().optional(),
  mobile: z.string().min(1, "Mobile number is required"),
  website: z.string().url("Invalid URL").optional().or(z.literal("")),
  title: z.string().optional(),
  secondary_email: z.string().email("Invalid email").optional().or(z.literal("")),
  status: z.enum([
    "new",
    "contacted",
    "tour_scheduled",
    "tour_completed",
    "proposal_sent",
    "negotiating",
    "won",
    "lost",
    "junk",
  ]),
  source: z.enum([
    "meta_ads",
    "google_ads",
    "direct_walkin",
    "referral",
    "cold_call",
    "aggregator",
  ]).or(z.string()),
  industry: z.string().optional(),
  no_of_employees: z.number().int().positive().optional(),
  rating: z.enum(["none", "hot", "warm", "cold"]),
  score: z.number().int().min(0).max(100),
  workspace_type: z
    .enum([
      "hot_desk",
      "dedicated_desk",
      "private_office",
      "meeting_room",
      "conference_room",
      "virtual_office",
      "managed",
      "enterprise",
    ])
    .optional(),
  seat_capacity: z.number().int().positive().optional(),
  preferred_location: z.string().optional(),
  location_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  pan_number: z.string().optional(),
  gst_number: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, "Invalid GST number format (e.g. 33AAAAA0000A1Z5)").optional().or(z.literal("")).transform(v => v || undefined),
  working_hours: z.string().optional(),
  budget_per_seat: z.number().positive().optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip_code: z.string().optional(),
  country: z.string().optional(),
  enquiry_form_google: z.string().url("Invalid URL").optional().or(z.literal("")),
  enquiry_form_direct: z.string().url("Invalid URL").optional().or(z.literal("")),
  description: z.string().optional(),
  entity_type: z.enum([
    "individual", "proprietorship", "partnership", "llp",
    "pvt_ltd", "public_ltd", "trust", "society", "huf", "other",
  ]).optional().nullable(),
  tags: z.array(z.string()),
  assigned_to: z.string().uuid().optional(),
  lost_reason: z.string().optional(),
  billing_emails: z.array(z.string().email("Invalid email in billing list")).optional(),
});

// source and status accept any string on update so legacy DB values (e.g. sources
// added before the current enum) don't block saves on unrelated fields like email.
export const updateLeadSchema = createLeadSchema.partial().extend({
  source: z.string().optional(),
  status: z.string().optional(),
});

// Relaxed schema for CSV imports — status/source/rating/score/tags have defaults
export const importLeadSchema = z.object({
  first_name: z.string().min(1, "First name is required"),
  last_name: z.string().optional(),
  company: z.string().optional(),
  aggregator_contact_name: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  website: z.string().optional(),
  title: z.string().optional(),
  secondary_email: z.string().email("Invalid email").optional().or(z.literal("")),
  status: z.enum([
    "new", "contacted", "tour_scheduled", "tour_completed",
    "proposal_sent", "negotiating", "won", "lost", "junk",
  ]).default("new"),
  source: z.enum([
    "meta_ads", "google_ads", "direct_walkin", "referral", "cold_call", "aggregator",
  ]).default("meta_ads"),
  industry: z.string().optional(),
  no_of_employees: z.number().int().positive().optional(),
  rating: z.enum(["none", "hot", "warm", "cold"]).default("none"),
  score: z.number().int().min(0).max(100).default(0),
  workspace_type: z.enum([
    "hot_desk", "dedicated_desk", "private_office",
    "meeting_room", "conference_room", "virtual_office",
    "managed", "enterprise",
  ]).optional(),
  seat_capacity: z.number().int().positive().optional(),
  preferred_location: z.string().optional(),
  working_hours: z.string().optional(),
  budget_per_seat: z.number().positive().optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip_code: z.string().optional(),
  country: z.string().optional(),
  enquiry_form_google: z.string().optional(),
  enquiry_form_direct: z.string().optional(),
  description: z.string().optional(),
  entity_type: z.enum([
    "individual", "proprietorship", "partnership", "llp",
    "pvt_ltd", "public_ltd", "trust", "society", "huf", "other",
  ]).optional().nullable(),
  tags: z.array(z.string()).default([]),
});

export type ImportLeadInput = z.infer<typeof importLeadSchema>;

export type CreateLeadInput = z.input<typeof createLeadSchema>;
export type UpdateLeadInput = z.input<typeof updateLeadSchema>;

// ==========================================
// Activity Validations
// ==========================================
export const createActivitySchema = z.object({
  lead_id: z.string().uuid("Invalid lead ID"),
  type: z.enum(["call", "meeting", "note", "email", "tour"]),
  subject: z.string().optional(),
  description: z.string().optional(),
  call_duration_seconds: z.number().int().min(0).optional(),
  call_outcome: z
    .enum([
      "connected",
      "no_answer",
      "voicemail",
      "busy",
      "wrong_number",
      "callback_scheduled",
    ])
    .optional(),
  meeting_location: z.string().optional(),
  meeting_start_at: z.string().optional(),
  meeting_end_at: z.string().optional(),
  follow_up_date: z.string().optional(),
  follow_up_notes: z.string().optional(),
});

export type CreateActivityInput = z.infer<typeof createActivitySchema>;

// ==========================================
// Task Validations
// ==========================================
export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "done"]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  lead_id: z.string().uuid().optional(),
  parent_task_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  due_date: z.string().optional(),
  tags: z.array(z.string()),
});

export const updateTaskSchema = createTaskSchema.partial();

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// ==========================================
// Proposal Validations
// ==========================================
export const lineItemSchema = z.object({
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be positive"),
  unit: z.string().optional(),
  unit_price: z.number().min(0, "Price must be non-negative"),
  total: z.number(),
});

export const createProposalSchema = z.object({
  lead_id: z.string().uuid("Invalid lead ID"),
  location_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  items: z.array(lineItemSchema).min(1, "At least one line item is required"),
  tax_percentage: z.number().min(0).max(100),
  discount_percentage: z.number().min(0).max(100),
  valid_until: z.string().optional(),
  terms_and_conditions: z.string().optional(),
  notes: z.string().optional(),
  complimentary_items: z.array(z.object({
    name: z.string().min(1),
    unit: z.string().min(1),
    quantity: z.number().min(0),
    price_per_unit: z.number().min(0).optional(),
  })).optional(),
  service_quotas: z.array(z.object({
    service_id: z.string().uuid(),
    monthly_quota: z.number().min(0),
    overage_rate: z.number().min(0),
  })).optional(),
  security_deposit_months: z.number().min(0).max(6).optional(),
  security_deposit_amount: z.number().min(0).optional(),
});

export const updateProposalSchema = createProposalSchema.partial();

export type CreateProposalInput = z.input<typeof createProposalSchema>;

// ==========================================
// Invoice Validations
// ==========================================
export const createInvoiceSchema = z.object({
  lead_id: z.string().uuid("Invalid lead ID").optional(),
  proposal_id: z.string().uuid().optional(),
  title: z.string().min(1, "Title is required"),
  // Security deposits are never billed through an ad-hoc invoice — they go
  // through the proposal deposit link instead (GST-exempt, tracked against
  // the deposit ledger). Enforced server-side in the POST handler.
  // Null means the creator picked "I don't know" — accounts follows up and
  // fills in the real head later (see PATCH /api/invoices/[id]).
  primary_head: z.enum(ACCOUNTING_HEADS, { message: "Select what this invoice is for" }).nullable(),
  items: z.array(lineItemSchema).min(1, "At least one line item is required"),
  tax_percentage: z.number().min(0).max(100),
  discount_percentage: z.number().min(0).max(100),
  due_date: z.string().optional(),
  // Customer-facing — printed on the invoice PDF/email.
  notes: z.string().optional(),
  // Internal-only — for accounts; never printed on the PDF or sent to the customer.
  internal_notes: z
    .string()
    .min(10, "Add more context so accounts can book this correctly"),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

// ==========================================
// Contract Validations
// ==========================================
export const createContractSchema = z.object({
  lead_id: z.string().uuid("Invalid lead ID"),
  proposal_id: z.string().uuid("A linked accepted proposal is required"),
  location_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  billing_cycle: z.enum(["monthly", "quarterly", "half_yearly", "yearly"]),
  tenure_months: z.number().int().positive("Tenure must be positive"),
  start_date: z.string().min(1, "Start date is required"),
  // Explicit occupancy end date. When provided it is authoritative; otherwise
  // end date is derived from start_date + tenure_months.
  end_date: z.string().optional(),
  seats: z.number().int().positive("Seats must be positive"),
  // Financials are always inherited from the linked proposal; this field is
  // optional and ignored by the API (kept for form state compatibility).
  monthly_membership_fee: z.number().min(0).optional().default(0),
  // Membership agreement fields
  workspace_description: z.string().min(1, "Workspace description is required"),
  parking_space: z.string().optional(),
  complimentary_services: z.string().optional(),
  security_deposit_months: z.number().min(0).default(3.0),
  escalation_percentage: z.number().min(0).max(100).default(10.0),
  notice_period_months: z.number().min(0).default(2.0),
  lock_in_months: z.number().min(1).max(18).optional().nullable(),
  member_signatory_name: z.string().min(1, "Signatory name is required"),
  member_signatory_designation: z.string().min(1, "Signatory designation is required"),
  member_signatory_pan: z.string().optional(),
  member_signatory_id_type: z.enum(['pan', 'aadhaar']).default('pan').optional(),
  agreement_date: z.string().min(1, "Agreement date is required"),
  // Optional fields
  terms_and_conditions: z.string().optional(),
  notes: z.string().optional(),
  // Lead data to save back
  pan_number: z.string().optional(),
}).refine(
  (d) => !d.end_date || d.end_date >= d.start_date,
  { message: "End date must be on or after the start date", path: ["end_date"] }
);

export type CreateContractInput = z.input<typeof createContractSchema>;

// ==========================================
// Usage Charge Validations
// ==========================================
export const createUsageChargeSchema = z.object({
  contract_id: z.string().uuid("Invalid contract ID").optional(),
  booking_id: z.string().uuid("Invalid booking ID").optional(),
  // When set, the server recomputes quantity/unit_price/total against the
  // facility's free_quota + cost_per_unit — see usage-charges/route.ts POST.
  contract_facility_id: z.string().uuid("Invalid facility ID").optional(),
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be positive"),
  unit_price: z.number().min(0, "Price must be non-negative"),
  total: z.number(),
  // GST is optional on the input but always stored — defaults to 18% when
  // omitted to match the rest of the booking-side flow. The server is the
  // source of truth for gst_amount + total_with_gst (computed from these).
  gst_rate: z.number().min(0).max(28).optional(),
  charge_date: z.string().min(1, "Charge date is required"),
  // HSN/SAC code for this line item — defaults to 999799 (Other Charges) when
  // not supplied. Stored on the row so invoice builders can use per-item codes.
  hsn_sac_code: z.string().optional(),
  notes: z.string().optional(),
}).refine(
  (data) => data.contract_id || data.booking_id,
  { message: "Either contract_id or booking_id is required" }
);

export type CreateUsageChargeInput = z.infer<typeof createUsageChargeSchema>;

// ==========================================
// Billing Statement Validations
// ==========================================
export const generateBillingStatementSchema = z.object({
  contract_id: z.string().uuid("Invalid contract ID").optional(),
  booking_id: z.string().uuid("Invalid booking ID").optional(),
  period_start: z.string().min(1, "Period start is required"),
  period_end: z.string().min(1, "Period end is required"),
  notes: z.string().optional(),
}).refine((d) => d.contract_id || d.booking_id, {
  message: "Either contract_id or booking_id is required",
});

// ==========================================
// Space Validations
// ==========================================
const operatingDaySchema = z.object({
  open: z.string().regex(/^\d{2}:\d{2}$/, "Time format must be HH:MM"),
  close: z.string().regex(/^\d{2}:\d{2}$/, "Time format must be HH:MM"),
  is_open: z.boolean(),
});

export const createSpaceSchema = z.object({
  name: z.string().min(1, "Name is required"),
  location_id: z.string().uuid("Invalid location ID"),
  capacity: z.number().int().positive("Capacity must be positive"),
  pricing_model: z.enum(["hourly", "daily"]).default("hourly"),
  // Hourly rate: required for hourly-priced spaces, can be 0 for daily-priced.
  hourly_rate: z.number().min(0),
  daily_rate: z.number().min(0).nullable().optional(),
  description: z.string().optional(),
  operating_hours: z.record(z.string(), operatingDaySchema).optional(),
  max_advance_booking_days: z.number().int().positive().default(30),
  // 0 is valid for day-pass (daily) spaces — they have no minimum duration.
  min_booking_minutes: z.number().int().min(0).default(60),
  // Contract-holder minimum for conference_room/meeting_room spaces only.
  min_booking_minutes_contract: z.number().int().min(0).default(30),
  cancellation_policy: z.string().optional(),
  facilities: z.array(z.object({
    name: z.string().min(1, "Facility name is required"),
    is_complimentary: z.boolean().default(true),
    charge_per_use: z.number().min(0).default(0),
  })).optional(),
  cosec_device_id: z.string().uuid().nullable().optional(),
  workspace_type: z.string().optional(),
});

export const updateSpaceSchema = createSpaceSchema.partial();

export type CreateSpaceInput = z.input<typeof createSpaceSchema>;

// ==========================================
// Booking Validations
// ==========================================
export const createBookingSchema = z.object({
  space_id: z.string().uuid("Invalid space ID"),
  booking_date: z.string().min(1, "Booking date is required"),
  // Times are optional for day-pass bookings — server fills them from
  // the centre's operating hours when the space is daily-priced.
  start_time: z.string().regex(/^\d{2}:\d{2}$/, "Start time required (HH:MM)").optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, "End time required (HH:MM)").optional(),
  customer_type: z.enum(["contract_holder", "walk_in", "guest"]),
  contract_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  lead_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  booker_phone: z.string().min(1, "Mobile number of the person booking is required"),
  booker_gst_number: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, "Invalid GST number format").optional().or(z.literal("")).transform(v => v || undefined),
  guest_name: z.string().optional(),
  guest_email: z.string().email("Invalid email").optional().or(z.literal("")),
  guest_phone: z.string().optional(),
  guest_company: z.string().optional(),
  facility_ids: z.array(z.string()).optional(),
  payment_mode: z.string().optional(),
  payment_reference: z.string().optional(),
  notes: z.string().optional(),
  hourly_rate: z.number().min(0).optional(),
  settle_charge_ids: z.array(z.string().uuid()).optional(),
  aggregator_booking_id: z.string().optional(),
  purpose: z.string().optional(),
  loi_number: z.string().optional(),
  access_provided_by: z.string().optional(),
  // Number of people attending — drives multi-voucher issuance (1 per 2 attendees)
  num_attendees: z.number().int().positive().optional(),
  // Number of day-pass seats — for daily-priced spaces; quantity × day_rate = total
  num_seats: z.number().int().min(1).optional(),
}).refine(data => {
  if (data.customer_type === "contract_holder" && !data.contract_id) return false;
  return true;
}, { message: "Contract ID required for contract holders", path: ["contract_id"] })
.refine(data => {
  if (data.customer_type === "walk_in" && !data.lead_id && !data.guest_name) return false;
  return true;
}, { message: "Either lead or guest name required for walk-ins", path: ["guest_name"] })
.refine(data => {
  if (data.customer_type === "guest" && !data.contract_id) return false;
  return true;
}, { message: "Contract ID required for guest bookings", path: ["contract_id"] });

export type CreateBookingInput = z.input<typeof createBookingSchema>;

// ==========================================
// Accounting Module Validations
// ==========================================
export const createContractFacilitySchema = z.object({
  contract_id: z.string().uuid("Invalid contract ID"),
  name: z.string().min(1, "Facility name is required"),
  unit: z.string().min(1, "Unit is required"),
  cost_per_unit: z.number().min(0, "Cost must be non-negative"),
  free_quota: z.number().min(0, "Free quota must be non-negative"),
});

export type CreateContractFacilityInput = z.infer<typeof createContractFacilitySchema>;

export const createFacilityUsageSchema = z.object({
  accounting_period_id: z.string().uuid("Invalid period ID"),
  contract_id: z.string().uuid("Invalid contract ID"),
  contract_facility_id: z.string().uuid("Invalid facility ID"),
  quantity_used: z.number().min(0, "Quantity must be non-negative"),
  notes: z.string().optional(),
});

export type CreateFacilityUsageInput = z.infer<typeof createFacilityUsageSchema>;

export const createContractPaymentSchema = z.object({
  contract_id: z.string().uuid("Invalid contract ID"),
  accounting_period_id: z.string().uuid("Invalid period ID").optional(),
  amount: z.number().positive("Amount must be positive"),
  payment_mode: z.enum(["cash", "upi", "card", "bank_transfer", "razorpay"]),
  payment_reference: z.string().optional(),
  payment_date: z.string().min(1, "Payment date is required"),
  notes: z.string().optional(),
});

export type CreateContractPaymentInput = z.infer<typeof createContractPaymentSchema>;

export const lockAccountingPeriodSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
});

export const updateGstInvoiceSchema = z.object({
  gst_invoice_number: z.string().min(1, "GST invoice number is required"),
});

// ==========================================
// Recurring Booking Validations
// ==========================================
export const createRecurringSeriesSchema = z.object({
  space_id: z.string().uuid("Invalid space ID"),
  customer_type: z.enum(["contract_holder", "walk_in", "guest"]),
  contract_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  lead_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  booker_phone: z.string().min(1, "Booker phone is required"),
  guest_name: z.string().optional(),
  guest_email: z.string().email("Invalid email").optional().or(z.literal("")),
  guest_phone: z.string().optional(),
  guest_company: z.string().optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, "Start time required (HH:MM)"),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, "End time required (HH:MM)"),
  frequency: z.enum(["daily", "weekly", "biweekly", "monthly"]),
  day_of_week: z.number().int().min(0).max(6).optional(),
  day_of_month: z.number().int().min(1).max(31).optional(),
  series_start: z.string().min(1, "Series start date is required"),
  series_end: z.string().min(1, "Series end date is required"),
  facility_ids: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export type CreateRecurringSeriesInput = z.input<typeof createRecurringSeriesSchema>;

// ==========================================
// Waitlist Validations
// ==========================================
export const createWaitlistEntrySchema = z.object({
  space_id: z.string().uuid("Invalid space ID"),
  booking_date: z.string().min(1, "Booking date is required"),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, "Start time required (HH:MM)"),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, "End time required (HH:MM)"),
  customer_type: z.enum(["contract_holder", "walk_in", "guest"]),
  contract_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  lead_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  guest_name: z.string().optional(),
  guest_phone: z.string().optional(),
  booker_phone: z.string().min(1, "Booker phone is required"),
  notes: z.string().optional(),
});

export type CreateWaitlistEntryInput = z.input<typeof createWaitlistEntrySchema>;

// ==========================================
// Reschedule Booking Validation
// ==========================================
export const rescheduleBookingSchema = z.object({
  new_date: z.string().min(1, "New date is required"),
  new_start_time: z.string().regex(/^\d{2}:\d{2}$/, "New start time required (HH:MM)"),
  new_end_time: z.string().regex(/^\d{2}:\d{2}$/, "New end time required (HH:MM)"),
});

export type RescheduleBookingInput = z.infer<typeof rescheduleBookingSchema>;

// ==========================================
// Extend Booking Validation
// ==========================================
export const extendBookingSchema = z.object({
  new_end_time: z.string().regex(/^\d{2}:\d{2}$/, "New end time required (HH:MM)"),
});

export type ExtendBookingInput = z.infer<typeof extendBookingSchema>;

// ==========================================
// Support Ticket Validations
// ==========================================
export const createSupportTicketSchema = z.object({
  subject: z.string().min(1, "Subject is required").max(200, "Subject must be under 200 characters"),
  description: z.string().optional(),
  type: z.enum(["bug", "feature_request", "feedback", "question"]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  page_url: z.string().optional(),
  user_agent: z.string().optional(),
  screen_resolution: z.string().optional(),
});

export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>;

export const updateSupportTicketSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed", "build_approved"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigned_to: z.string().uuid().optional().or(z.literal("")).transform(v => v || null),
  build_approved_notes: z.string().min(1).optional(),
}).superRefine((data, ctx) => {
  if (data.status === "build_approved" && !data.build_approved_notes?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["build_approved_notes"],
      message: "Approval notes are required when setting status to Build Approved",
    });
  }
});

export type UpdateSupportTicketInput = z.input<typeof updateSupportTicketSchema>;

export const createTicketNoteSchema = z.object({
  note: z.string().min(1, "Note is required"),
});

export type CreateTicketNoteInput = z.infer<typeof createTicketNoteSchema>;

// ==========================================
// Aggregator Validations
// ==========================================
// Base shape with NO .default() modifiers — z.object(...).partial() still
// applies .default() to any field omitted from the input (a documented Zod
// behavior), which silently resets that field in the DB on every partial
// PATCH that doesn't mention it. Confirmed live: a PATCH with only
// { billing_mode } was resetting billing_method back to 'postpaid'. Defaults
// belong only on createAggregatorSchema, for genuinely-new records.
const aggregatorFieldsSchema = z.object({
  name: z.string().min(1, "Name is required"),
  company_name: z.string().min(1, "Company name is required"),
  gst_number: z.string().max(20).optional(),
  pan_number: z.string().max(15).optional(),
  email_domain: z.string().optional(),
  primary_email: z.string().email("Invalid email").optional().or(z.literal("")),
  primary_phone: z.string().optional(),
  billing_address: z.string().optional(),
  billing_city: z.string().optional(),
  billing_state: z.string().optional(),
  billing_pincode: z.string().optional(),
  same_state_as_twv: z.boolean(),
  commission_percentage: z.number().min(0).max(100),
  default_rate_card: z.record(z.string(), z.number()),
  billing_method: z.enum(["postpaid", "prepaid"]),
  billing_mode: z.enum(["proforma_first", "gst_direct"]),
  credit_limit: z.number().min(0).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()),
  contacts: z.array(z.object({
    name: z.string().min(1, "Contact name is required"),
    email: z.string().email().optional().or(z.literal("")),
    phone: z.string().optional(),
    designation: z.string().optional(),
    is_primary: z.boolean().default(false),
  })).optional(),
});

export const createAggregatorSchema = aggregatorFieldsSchema.extend({
  same_state_as_twv: z.boolean().default(false),
  commission_percentage: z.number().min(0).max(100).default(0),
  default_rate_card: z.record(z.string(), z.number()).default({}),
  billing_method: z.enum(["postpaid", "prepaid"]).default("postpaid"),
  billing_mode: z.enum(["proforma_first", "gst_direct"]).default("gst_direct"),
  tags: z.array(z.string()).default([]),
});

// .partial() alone isn't enough for company_name: it allows the KEY to be
// omitted or `undefined`, but a blank text input still submits "" (a defined
// value), which still fails the base schema's .min(1) — silently blocking
// saves on any legacy aggregator with no company name on file. Override it
// to explicitly accept "" on update, since re-requiring it retroactively
// was never the intent (see fix/aggregator-edit-company-name-validation).
export const updateAggregatorSchema = aggregatorFieldsSchema.partial().extend({
  company_name: z.string().optional().or(z.literal("")),
});
export type CreateAggregatorInput = z.input<typeof createAggregatorSchema>;
export type UpdateAggregatorInput = z.input<typeof updateAggregatorSchema>;

// ==========================================
// Case (Virtual Office) Validations
// ==========================================
// No .default() modifiers here — z.object(...).partial() still applies
// .default() to any field omitted from the input (confirmed live: a PATCH
// with only { bill_to } was silently resetting case_source, tenure_months,
// security_deposit, and tags back to their defaults). Defaults belong only
// on createCaseSchema, for genuinely-new records; see the identical fix on
// aggregatorFieldsSchema above.
const caseFieldsSchema = z.object({
  // Direct clients (no referral aggregator) have aggregator_id omitted —
  // enforced by the refine() below, not by this field alone.
  case_source: z.enum(["aggregator", "direct"]),
  aggregator_id: z.string().uuid("Invalid aggregator ID").optional().or(z.literal("")).transform(v => v || undefined),
  aggregator_contact_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  location_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  purpose: z.enum(["gst_registration", "mca_registration", "branch_office", "mail_handling", "business_address"]),
  is_renewal: z.boolean(),
  parent_case_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  client_name: z.string().min(1, "Client name is required"),
  client_entity_type: z.enum(["individual", "proprietorship", "partnership", "llp", "pvt_ltd", "public_ltd", "trust", "society", "huf", "other"]),
  client_company_name: z.string().optional(),
  client_gst_number: z.string().max(20).optional(),
  client_pan_number: z.string().max(15).optional(),
  client_cin_number: z.string().max(25).optional(),
  client_email: z.string().email("Invalid email").optional().or(z.literal("")).transform(v => v || undefined),
  client_phone: z.string().optional(),
  client_address: z.string().optional(),
  client_city: z.string().optional(),
  client_state: z.string().optional(),
  client_pincode: z.string().optional(),
  represented_by_name: z.string().optional(),
  represented_by_designation: z.string().optional(),
  represented_by_id_type: z.enum(["pan", "aadhaar"]).optional(),
  represented_by_id_number: z.string().optional(),
  rate: z.number().positive("Rate must be positive").optional(),
  tenure_months: z.number().int().positive(),
  start_date: z.string().optional(),
  security_deposit: z.number().min(0),
  notes: z.string().optional(),
  tags: z.array(z.string()),
  assigned_to: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  // Prepaid-aggregator cases only: who the per-case invoice bills. Set
  // explicitly per case (varies case to case) — no create-time default.
  bill_to: z.enum(["aggregator", "client"]).optional(),
  // Direct-client cases only (no aggregator to hold a mode) — mirrors
  // aggregators.billing_mode.
  billing_mode: z.enum(["proforma_first", "gst_direct"]).optional(),
});

export const createCaseSchema = caseFieldsSchema
  .extend({
    case_source: z.enum(["aggregator", "direct"]).default("aggregator"),
    is_renewal: z.boolean().default(false),
    tenure_months: z.number().int().positive().default(12),
    security_deposit: z.number().min(0).default(0),
    tags: z.array(z.string()).default([]),
    billing_mode: z.enum(["proforma_first", "gst_direct"]).default("proforma_first"),
  })
  .refine((data) => data.case_source !== "aggregator" || !!data.aggregator_id, {
    message: "aggregator_id is required for aggregator-referred cases",
    path: ["aggregator_id"],
  })
  .refine((data) => data.case_source !== "direct" || !!data.aggregator_id === false, {
    message: "Direct-client cases must not have an aggregator_id",
    path: ["aggregator_id"],
  })
  .refine((data) => data.case_source !== "direct" || data.rate !== undefined, {
    message: "Rate must be entered manually for direct-client cases (no rate card to pull from)",
    path: ["rate"],
  });

export const updateCaseSchema = caseFieldsSchema.partial();
export type CreateCaseInput = z.input<typeof createCaseSchema>;
export type UpdateCaseInput = z.input<typeof updateCaseSchema>;

// ==========================================
// Case Comment Validations
// ==========================================
export const createCaseCommentSchema = z.object({
  comment: z.string().min(1, "Comment is required"),
  is_internal: z.boolean().default(true),
});
export type CreateCaseCommentInput = z.infer<typeof createCaseCommentSchema>;

// ==========================================
// Case Document Review Validations
// ==========================================
export const reviewCaseDocumentSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  rejection_reason: z.string().optional(),
  notes: z.string().optional(),
});
export type ReviewCaseDocumentInput = z.infer<typeof reviewCaseDocumentSchema>;

// ==========================================
// Compliance Check Validations
// ==========================================
export const updateComplianceCheckSchema = z.object({
  status: z.enum(["passed", "failed", "waived"]),
  notes: z.string().optional(),
});
export type UpdateComplianceCheckInput = z.infer<typeof updateComplianceCheckSchema>;

// ==========================================
// Case Status Transition Validation
// ==========================================
export const transitionCaseStatusSchema = z.object({
  status: z.enum([
    "intake_received", "docs_requested", "docs_received", "under_review",
    "compliance_check", "internal_approved", "sent_for_client_approval",
    "client_approved", "signing_in_progress", "executed",
    "invoiced", "active", "renewal_due", "grace_period", "renewed", "lapsed",
  ]),
  notes: z.string().optional(),
});
export type TransitionCaseStatusInput = z.infer<typeof transitionCaseStatusSchema>;
