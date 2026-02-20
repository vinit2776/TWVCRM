import { z } from "zod";

// ==========================================
// Lead Validations
// ==========================================
export const createLeadSchema = z.object({
  first_name: z.string().min(1, "First name is required"),
  last_name: z.string().min(1, "Last name is required"),
  company: z.string().optional(),
  aggregator_contact_name: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().optional(),
  mobile: z.string().optional(),
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
  ]),
  source: z.enum([
    "meta_ads",
    "direct_walkin",
    "online_form",
    "referral",
    "social_media",
    "advertisement",
    "cold_call",
    "event",
    "partner",
    "other",
  ]),
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
    ])
    .optional(),
  seat_capacity: z.number().int().positive().optional(),
  preferred_location: z.string().optional(),
  location_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  pan_number: z.string().optional(),
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
  tags: z.array(z.string()),
  assigned_to: z.string().uuid().optional(),
  lost_reason: z.string().optional(),
});

export const updateLeadSchema = createLeadSchema.partial();

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
const lineItemSchema = z.object({
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be positive"),
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
  items: z.array(lineItemSchema).min(1, "At least one line item is required"),
  tax_percentage: z.number().min(0).max(100),
  discount_percentage: z.number().min(0).max(100),
  due_date: z.string().optional(),
  notes: z.string().optional(),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

// ==========================================
// Contract Validations
// ==========================================
export const createContractSchema = z.object({
  lead_id: z.string().uuid("Invalid lead ID"),
  proposal_id: z.string().uuid("Invalid proposal ID").optional().or(z.literal("")).transform(v => v || undefined),
  location_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  billing_cycle: z.enum(["monthly", "quarterly", "half_yearly", "yearly"]),
  tenure_months: z.number().int().positive("Tenure must be positive"),
  start_date: z.string().min(1, "Start date is required"),
  seats: z.number().int().positive("Seats must be positive"),
  monthly_membership_fee: z.number().positive("Monthly fee must be positive"),
  // Membership agreement fields
  workspace_description: z.string().min(1, "Workspace description is required"),
  parking_space: z.string().optional(),
  complimentary_services: z.string().optional(),
  security_deposit_months: z.number().min(0).default(3.0),
  escalation_percentage: z.number().min(0).max(100).default(10.0),
  notice_period_months: z.number().min(0).default(2.0),
  member_signatory_name: z.string().min(1, "Signatory name is required"),
  member_signatory_designation: z.string().min(1, "Signatory designation is required"),
  agreement_date: z.string().min(1, "Agreement date is required"),
  // Optional fields
  terms_and_conditions: z.string().optional(),
  notes: z.string().optional(),
  // Lead data to save back
  pan_number: z.string().optional(),
});

export type CreateContractInput = z.input<typeof createContractSchema>;

// ==========================================
// Usage Charge Validations
// ==========================================
export const createUsageChargeSchema = z.object({
  contract_id: z.string().uuid("Invalid contract ID"),
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be positive"),
  unit_price: z.number().min(0, "Price must be non-negative"),
  total: z.number(),
  charge_date: z.string().min(1, "Charge date is required"),
  notes: z.string().optional(),
});

export type CreateUsageChargeInput = z.infer<typeof createUsageChargeSchema>;

// ==========================================
// Billing Statement Validations
// ==========================================
export const generateBillingStatementSchema = z.object({
  contract_id: z.string().uuid("Invalid contract ID"),
  period_start: z.string().min(1, "Period start is required"),
  period_end: z.string().min(1, "Period end is required"),
  notes: z.string().optional(),
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
  hourly_rate: z.number().positive("Hourly rate must be positive"),
  description: z.string().optional(),
  operating_hours: z.record(z.string(), operatingDaySchema).optional(),
  max_advance_booking_days: z.number().int().positive().default(30),
  min_booking_minutes: z.number().int().min(30).default(60),
  cancellation_policy: z.string().optional(),
  facilities: z.array(z.object({
    name: z.string().min(1, "Facility name is required"),
    is_complimentary: z.boolean().default(true),
    charge_per_use: z.number().min(0).default(0),
  })).optional(),
});

export const updateSpaceSchema = createSpaceSchema.partial();

export type CreateSpaceInput = z.input<typeof createSpaceSchema>;

// ==========================================
// Booking Validations
// ==========================================
export const createBookingSchema = z.object({
  space_id: z.string().uuid("Invalid space ID"),
  booking_date: z.string().min(1, "Booking date is required"),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, "Start time required (HH:MM)"),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, "End time required (HH:MM)"),
  customer_type: z.enum(["contract_holder", "walk_in", "guest"]),
  contract_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  lead_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  booker_phone: z.string().min(1, "Mobile number of the person booking is required"),
  guest_name: z.string().optional(),
  guest_email: z.string().email("Invalid email").optional().or(z.literal("")),
  guest_phone: z.string().optional(),
  guest_company: z.string().optional(),
  facility_ids: z.array(z.string()).optional(),
  payment_mode: z.string().optional(),
  payment_reference: z.string().optional(),
  notes: z.string().optional(),
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
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigned_to: z.string().uuid().optional().or(z.literal("")).transform(v => v || null),
});

export type UpdateSupportTicketInput = z.input<typeof updateSupportTicketSchema>;

export const createTicketNoteSchema = z.object({
  note: z.string().min(1, "Note is required"),
});

export type CreateTicketNoteInput = z.infer<typeof createTicketNoteSchema>;
