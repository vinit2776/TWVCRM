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
