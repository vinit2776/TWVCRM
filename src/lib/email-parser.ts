import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { VoPurpose, EntityType } from "@/types";

// Overridable via app_settings-style env var so the extraction model can be
// bumped without a code change/redeploy for this one call site.
const DEFAULT_EXTRACTION_MODEL = "claude-sonnet-4-20250514";
const EXTRACTION_MODEL =
  process.env.ANTHROPIC_EMAIL_PARSER_MODEL || DEFAULT_EXTRACTION_MODEL;

const REQUEST_TIMEOUT_MS = 30_000;

export interface ParsedCaseData {
  /** Extracted client/company name */
  client_name: string;
  /** Best-guess entity type */
  client_entity_type: EntityType;
  /** Company name if different from client name */
  client_company_name?: string;
  /** GST number if found */
  client_gst_number?: string;
  /** PAN number if found */
  client_pan_number?: string;
  /** CIN number if found */
  client_cin_number?: string;
  /** Client email if found */
  client_email?: string;
  /** Client phone if found */
  client_phone?: string;
  /** Client address */
  client_address?: string;
  /** Client city */
  client_city?: string;
  /** Client state */
  client_state?: string;
  /** Client pincode */
  client_pincode?: string;
  /** Purpose of virtual office */
  purpose: VoPurpose;
  /** Monthly rate if mentioned */
  rate?: number;
  /** Tenure in months if mentioned */
  tenure_months?: number;
  /** Start date if mentioned */
  start_date?: string;
  /** Location preference if mentioned */
  preferred_location?: string;
  /** Any additional notes from the email */
  notes?: string;
  /** Confidence score 0-1 indicating how certain the extraction is */
  confidence: number;
  /** Fields that could not be reliably extracted */
  missing_fields: string[];
  /** Raw extracted data for debugging */
  raw_extraction: Record<string, unknown>;
}

const EXTRACTION_PROMPT = `You are an expert at extracting structured data from aggregator emails requesting virtual office services in India.

Analyze the email below and extract the following fields. Return ONLY valid JSON with no markdown formatting.

Required fields:
- client_name: The name of the end-client (person or entity requesting the virtual office)
- client_entity_type: One of: individual, proprietorship, partnership, llp, pvt_ltd, public_ltd, trust, society, huf, other
- purpose: One of: gst_registration, mca_registration, branch_office, mail_handling, business_address

Optional fields (include if found):
- client_company_name: Company/firm/LLP name if different from client_name
- client_gst_number: GST number (format: 2-digit state code + PAN + entity code + checksum)
- client_pan_number: PAN number (format: 5 letters + 4 digits + 1 letter)
- client_cin_number: CIN/LLPIN number
- client_email: Client's email address
- client_phone: Client's phone number
- client_address: Full address
- client_city: City name
- client_state: State name
- client_pincode: 6-digit pincode
- rate: Monthly rate in INR (number only, no currency symbol)
- tenure_months: Duration in months (number)
- start_date: Start date in YYYY-MM-DD format
- preferred_location: Any location/area preference mentioned
- notes: Any additional context, special requirements, or instructions

Also return:
- confidence: A number between 0 and 1 indicating overall extraction confidence
- missing_fields: Array of field names that could not be reliably extracted but are typically needed

Guidelines:
- "GST registration" → purpose = "gst_registration"
- "Company registration" or "MCA" or "ROC" → purpose = "mca_registration"
- "Branch office" → purpose = "branch_office"
- "Mail handling" or "postal" → purpose = "mail_handling"
- "Business address" or just "virtual office" with no specific purpose → purpose = "business_address"
- "Pvt Ltd" or "Private Limited" → entity_type = "pvt_ltd"
- "LLP" → entity_type = "llp"
- If amount mentioned with "per month" or "monthly" → extract as rate
- If duration like "1 year" → tenure_months = 12, "2 years" → 24, "6 months" → 6
- Default tenure_months to 12 if not mentioned but purpose is gst_registration or mca_registration
- If you cannot determine a field, omit it from the response rather than guessing`;

// Loose shape check on the LLM's JSON — types are coerced defensively below
// since a model can return e.g. rate as a string ("50000") or a number.
// .passthrough() keeps any extra fields so raw_extraction still reflects
// exactly what the model returned.
const ParsedResponseSchema = z
  .object({
    client_name: z.union([z.string(), z.number()]).optional(),
    client_entity_type: z.union([z.string(), z.number()]).optional(),
    client_company_name: z.union([z.string(), z.number()]).optional(),
    client_gst_number: z.union([z.string(), z.number()]).optional(),
    client_pan_number: z.union([z.string(), z.number()]).optional(),
    client_cin_number: z.union([z.string(), z.number()]).optional(),
    client_email: z.union([z.string(), z.number()]).optional(),
    client_phone: z.union([z.string(), z.number()]).optional(),
    client_address: z.union([z.string(), z.number()]).optional(),
    client_city: z.union([z.string(), z.number()]).optional(),
    client_state: z.union([z.string(), z.number()]).optional(),
    client_pincode: z.union([z.string(), z.number()]).optional(),
    purpose: z.union([z.string(), z.number()]).optional(),
    rate: z.union([z.number(), z.string()]).optional(),
    tenure_months: z.union([z.number(), z.string()]).optional(),
    start_date: z.union([z.string(), z.number()]).optional(),
    preferred_location: z.union([z.string(), z.number()]).optional(),
    notes: z.union([z.string(), z.number()]).optional(),
    confidence: z.union([z.number(), z.string()]).optional(),
    missing_fields: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Extract a JSON object from the model's raw text response, handling the
 * common cases: a bare JSON object, one wrapped in a markdown code fence, or
 * JSON surrounded by extra prose the model added despite instructions.
 * Throws if no parseable object can be found.
 */
export function extractJsonFromResponse(responseText: string): unknown {
  try {
    return JSON.parse(responseText);
  } catch {
    // Try extracting JSON from a markdown code block
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1].trim());
    }
    // Last resort: find first { to last }
    const start = responseText.indexOf("{");
    const end = responseText.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(responseText.substring(start, end + 1));
    }
    throw new Error("Could not parse AI response as JSON");
  }
}

/**
 * Validate that the extracted JSON matches the expected extraction shape.
 * Returns the validated (passthrough) object, or throws with the Zod issue
 * details if the model returned something structurally unusable (e.g. an
 * array, a scalar, or fields of a type we can't coerce).
 */
export function validateParsedResponse(raw: unknown): Record<string, unknown> {
  const result = ParsedResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `AI response failed validation: ${result.error.message}`
    );
  }
  return result.data as Record<string, unknown>;
}

/**
 * Normalize a validated extraction object into the final ParsedCaseData
 * shape, coercing optional fields and defaulting unrecognized enum values.
 */
export function normalizeParsedCaseData(
  parsed: Record<string, unknown>
): ParsedCaseData {
  // Number(parsed.confidence) || 0.5 previously mapped a legitimate 0
  // confidence to 0.5, defeating the isHighConfidence low end — use an
  // explicit finite check instead so 0 is preserved.
  const confidenceNum = Number(parsed.confidence);
  const confidence = Number.isFinite(confidenceNum) ? confidenceNum : 0.5;

  const result: ParsedCaseData = {
    client_name: String(parsed.client_name || "Unknown"),
    client_entity_type: validateEntityType(
      String(parsed.client_entity_type || "other")
    ),
    purpose: validatePurpose(
      String(parsed.purpose || "business_address")
    ),
    confidence,
    missing_fields: Array.isArray(parsed.missing_fields)
      ? parsed.missing_fields.map(String)
      : [],
    raw_extraction: parsed,
  };

  // Map optional fields
  if (parsed.client_company_name)
    result.client_company_name = String(parsed.client_company_name);
  if (parsed.client_gst_number)
    result.client_gst_number = String(parsed.client_gst_number);
  if (parsed.client_pan_number)
    result.client_pan_number = String(parsed.client_pan_number);
  if (parsed.client_cin_number)
    result.client_cin_number = String(parsed.client_cin_number);
  if (parsed.client_email)
    result.client_email = String(parsed.client_email);
  if (parsed.client_phone)
    result.client_phone = String(parsed.client_phone);
  if (parsed.client_address)
    result.client_address = String(parsed.client_address);
  if (parsed.client_city) result.client_city = String(parsed.client_city);
  if (parsed.client_state)
    result.client_state = String(parsed.client_state);
  if (parsed.client_pincode)
    result.client_pincode = String(parsed.client_pincode);
  if (parsed.rate) result.rate = Number(parsed.rate);
  if (parsed.tenure_months)
    result.tenure_months = Number(parsed.tenure_months);
  if (parsed.start_date) result.start_date = String(parsed.start_date);
  if (parsed.preferred_location)
    result.preferred_location = String(parsed.preferred_location);
  if (parsed.notes) result.notes = String(parsed.notes);

  return result;
}

/**
 * Parse an aggregator email using Anthropic Claude to extract structured case data.
 * Returns parsed data with confidence score. Below 0.7 confidence = flag for manual review.
 */
export async function parseAggregatorEmail(
  emailContent: string,
  emailSubject?: string
): Promise<ParsedCaseData> {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const fullContent = [
    emailSubject ? `Subject: ${emailSubject}` : "",
    "",
    emailContent,
  ]
    .filter(Boolean)
    .join("\n");

  const message = await anthropic.messages.create(
    {
      model: EXTRACTION_MODEL,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `${EXTRACTION_PROMPT}\n\n--- EMAIL START ---\n${fullContent}\n--- EMAIL END ---`,
        },
      ],
    },
    // maxRetries: 1 → one retry (two attempts total) on transient/retryable
    // errors, on top of the request timeout below.
    { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 }
  );

  // Extract text from the response
  const responseText = message.content
    .filter((block) => block.type === "text")
    .map((block) => {
      if (block.type === "text") return block.text;
      return "";
    })
    .join("");

  const raw = extractJsonFromResponse(responseText);
  const validated = validateParsedResponse(raw);
  return normalizeParsedCaseData(validated);
}

function validatePurpose(value: string): VoPurpose {
  const valid: VoPurpose[] = [
    "gst_registration",
    "mca_registration",
    "branch_office",
    "mail_handling",
    "business_address",
  ];
  return valid.includes(value as VoPurpose)
    ? (value as VoPurpose)
    : "business_address";
}

function validateEntityType(value: string): EntityType {
  const valid: EntityType[] = [
    "individual",
    "proprietorship",
    "partnership",
    "llp",
    "pvt_ltd",
    "public_ltd",
    "trust",
    "society",
    "huf",
    "other",
  ];
  return valid.includes(value as EntityType)
    ? (value as EntityType)
    : "other";
}

/**
 * Check if parsed data has high enough confidence for auto-processing.
 * Returns true if confidence ≥ 0.7 and no critical fields are missing.
 */
export function isHighConfidence(parsed: ParsedCaseData): boolean {
  if (parsed.confidence < 0.7) return false;

  const criticalFields = ["client_name", "purpose", "client_entity_type"];
  const hasCritical = criticalFields.every(
    (f) => !parsed.missing_fields.includes(f)
  );

  return hasCritical;
}
