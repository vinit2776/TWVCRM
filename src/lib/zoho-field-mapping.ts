import type { LeadStatus, LeadSource, WorkspaceType, Rating } from "@/types";

// --- Enum value mappings (Zoho value → TWV CRM enum) ---

const ZOHO_STATUS_MAP: Record<string, LeadStatus> = {
  "sale won": "won",
  "not interested": "lost",
  "sale lost": "lost",
  "lead lost": "lost",
  "site visit completed": "tour_completed",
  "junk lead": "lost",
  "site visit": "tour_scheduled",
  "site visit booked": "tour_scheduled",
  "prospect": "contacted",
  "could not connect": "contacted",
  "call back later": "contacted",
  "proposal sent": "proposal_sent",
  "future prospect": "new",
  "still exploring- post site visit": "tour_completed",
};

const ZOHO_SOURCE_MAP: Record<string, LeadSource> = {
  "meta ads": "meta_ads",
  "online form": "referral",
  "direct/walk-in": "direct_walkin",
  "walk in": "direct_walkin",
  "agreegator": "aggregator",
  "inbound call": "cold_call",
  "google ads": "google_ads",
  "sales email alias": "cold_call",
  "chat": "referral",
  "advertisement": "meta_ads",
};

// When Lead Source is empty, use Description to infer source
const DESCRIPTION_SOURCE_MAP: Record<string, LeadSource> = {
  "walkin": "direct_walkin",
  "walk in": "direct_walkin",
  "workvilla site": "referral",
  "phone": "cold_call",
  "old client": "referral",
};

const ZOHO_WORKSPACE_MAP: Record<string, WorkspaceType> = {
  "private cabin": "private_office",
  "private cabin.": "private_office",
  "dedicated desk": "dedicated_desk",
  "virtual office": "virtual_office",
  "conference room": "conference_room",
  "managed office": "private_office",
  "day pass": "hot_desk",
  "flexi pass": "hot_desk",
};

const ZOHO_RATING_MAP: Record<string, Rating> = {
  "active": "warm",
};

// --- Numeric parsers ---

/** Sanitize a URL — prepend https:// if missing a scheme, return undefined if not a URL */
function sanitizeUrl(raw: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Add https:// if no scheme present
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    new URL(withScheme);
    return withScheme;
  } catch {
    return undefined;
  }
}

/** Extract a number from messy strings like "6000 plus gst", "5k", "5,500" */
function parseNumeric(raw: string): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/,/g, "").trim().toLowerCase();
  // Handle "5k" → 5000
  const kMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  // Extract first number
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  return match ? Math.round(parseFloat(match[1])) : undefined;
}

/** Extract first integer from seat capacity strings like "30-seater cabin", "10/ 3" */
function parseSeatCapacity(raw: string): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

// --- Status helpers ---

function mapStatus(raw: string): LeadStatus {
  const key = raw.trim().toLowerCase();
  return ZOHO_STATUS_MAP[key] || "new";
}

function mapSource(raw: string, description: string): LeadSource {
  const key = raw.trim().toLowerCase();
  if (key && ZOHO_SOURCE_MAP[key]) return ZOHO_SOURCE_MAP[key];
  // If source is empty, try to infer from description
  if (!key) {
    const descKey = description.trim().toLowerCase();
    if (descKey && DESCRIPTION_SOURCE_MAP[descKey]) return DESCRIPTION_SOURCE_MAP[descKey];
  }
  return "referral";
}

function mapWorkspaceType(raw: string): WorkspaceType | undefined {
  if (!raw) return undefined;
  // Handle multi-value like "Day Pass;Private Cabin" — take the first
  const first = raw.split(";")[0].trim().toLowerCase();
  return ZOHO_WORKSPACE_MAP[first] || undefined;
}

function mapRating(raw: string): Rating {
  const key = raw.trim().toLowerCase();
  return ZOHO_RATING_MAP[key] || "none";
}

// --- Row transform ---

export interface ZohoLeadRow {
  [key: string]: string;
}

export interface TransformedLead {
  first_name: string;
  last_name: string;
  company?: string;
  aggregator_contact_name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  website?: string;
  title?: string;
  secondary_email?: string;
  status: LeadStatus;
  source: LeadSource;
  industry?: string;
  no_of_employees?: number;
  rating: Rating;
  score: number;
  workspace_type?: WorkspaceType;
  seat_capacity?: number;
  preferred_location?: string;
  working_hours?: string;
  budget_per_seat?: number;
  street?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  country?: string;
  enquiry_form_google?: string;
  enquiry_form_direct?: string;
  description?: string;
  tags: string[];
  created_at?: string;
}

export interface TransformResult {
  lead: TransformedLead | null;
  warnings: string[];
  error: string | null;
}

export function transformZohoRow(row: ZohoLeadRow, rowIndex: number): TransformResult {
  const warnings: string[] = [];

  const firstName = (row["First Name"] || "").trim();
  const lastName = (row["Last Name"] || "").trim();

  if (!lastName) {
    return { lead: null, warnings, error: `Row ${rowIndex}: Missing Last Name` };
  }

  const rawDescription = (row["Description"] || "").trim();
  const rawSource = (row["Lead Source"] || "").trim();
  const source = mapSource(rawSource, rawDescription);

  // Determine if description was used for source inference and should be cleared
  const descUsedAsSource =
    !rawSource &&
    rawDescription &&
    DESCRIPTION_SOURCE_MAP[rawDescription.toLowerCase()] !== undefined;

  // Build tags from Tag column + Lead Sub Status
  const tags: string[] = [];
  const tagRaw = (row["Tag"] || "").trim();
  if (tagRaw) {
    tags.push(...tagRaw.split(",").map((t) => t.trim()).filter(Boolean));
  }
  const subStatus = (row["Lead Sub Status"] || "").trim();
  if (subStatus) {
    tags.push(subStatus);
  }

  // Parse created_at from Zoho's "Created Time" (format: "2025-07-09 17:30:33")
  let createdAt: string | undefined;
  const createdTimeRaw = (row["Created Time"] || "").trim();
  if (createdTimeRaw) {
    // Convert "2025-07-09 17:30:33" → ISO with timezone assumption (IST = +05:30)
    createdAt = createdTimeRaw.replace(" ", "T") + "+05:30";
  }

  // Parse seat capacity (free-text)
  const seatRaw = (row["Seat Capacity"] || "").trim();
  const seatCapacity = parseSeatCapacity(seatRaw);
  if (seatRaw && !seatCapacity) {
    warnings.push(`Row ${rowIndex}: Could not parse seat capacity "${seatRaw}"`);
  }

  // Parse budget (free-text)
  const budgetRaw = (row["Budget Per Seat / Per Cabin (Monthly)"] || "").trim();
  const budget = parseNumeric(budgetRaw);
  if (budgetRaw && !budget) {
    warnings.push(`Row ${rowIndex}: Could not parse budget "${budgetRaw}"`);
  }

  // Parse no_of_employees
  const empRaw = (row["No. of Employees"] || "").trim();
  const noOfEmployees = empRaw ? parseInt(empRaw, 10) : undefined;

  // Truncate phone/mobile to VARCHAR(20) DB limit, strip formatting chars
  const truncatePhone = (raw: string) => {
    const cleaned = raw.trim().replace(/\s+/g, "");
    return cleaned.slice(0, 20) || undefined;
  };

  const lead: TransformedLead = {
    first_name: firstName || lastName, // Copy last name if first is empty
    last_name: lastName,
    company: (row["Company"] || "").trim() || undefined,
    aggregator_contact_name: (row["Aggregator Contact Person Name"] || "").trim() || undefined,
    email: (row["Email"] || "").trim() || undefined,
    phone: truncatePhone(row["Phone"] || ""),
    mobile: truncatePhone(row["Mobile"] || ""),
    website: sanitizeUrl(row["Website"] || ""),
    title: (row["Title"] || "").trim() || undefined,
    secondary_email: (row["Secondary Email"] || "").trim() || undefined,
    status: mapStatus(row["Lead Status"] || ""),
    source,
    industry: (row["Industry"] || "").trim() || undefined,
    no_of_employees: noOfEmployees && noOfEmployees > 0 ? noOfEmployees : undefined,
    rating: mapRating(row["Rating"] || ""),
    score: 0,
    workspace_type: mapWorkspaceType(row["Workspace Type"] || ""),
    seat_capacity: seatCapacity && seatCapacity > 0 ? seatCapacity : undefined,
    preferred_location: (row["Prefered Location"] || "").trim() || undefined,
    working_hours: (row["What are your working hours or shift timings?"] || "").trim() || undefined,
    budget_per_seat: budget && budget > 0 ? budget : undefined,
    street: (row["Street"] || "").trim() || undefined,
    city: (row["City"] || "").trim() || undefined,
    state: (row["State"] || "").trim() || undefined,
    zip_code: (row["Zip Code"] || "").trim() || undefined,
    country: (row["Country"] || "").trim() || undefined,
    enquiry_form_google: (row["Enquiry Form - Google"] || "").trim() || undefined,
    enquiry_form_direct: (row["Enquiry Form - Direct/walk-in"] || "").trim() || undefined,
    description: descUsedAsSource ? undefined : rawDescription || undefined,
    tags,
    created_at: createdAt,
  };

  return { lead, warnings, error: null };
}
