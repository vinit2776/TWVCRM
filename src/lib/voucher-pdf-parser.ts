import { PDFParse } from "pdf-parse";

export interface ParsedVoucherResult {
  vouchers: Array<{ voucher_code: string; metadata: Record<string, unknown> }>;
  detected_validity: number | null;
  errors: string[];
}

/**
 * WiFi system PDFs use a custom font that maps certain characters to
 * Private Use Area (PUA) Unicode codepoints. The dash separator and
 * the digit "0" are encoded as PUA chars in the text layer:
 *
 *   U+E088 (57480) → "-" (dash between the two 5-digit halves)
 *   U+E06B (57451) → "0" (digit zero)
 *
 * This function normalises the raw extracted text so that standard
 * regex matching works on the decoded voucher codes.
 */
function normalisePdfText(raw: string): string {
  return raw
    .replace(/\uE088/g, "-")
    .replace(/\uE06B/g, "0");
}

/**
 * Parses a PDF buffer containing WiFi vouchers.
 *
 * WiFi system PDFs have a repeating structure per voucher:
 *   "Valid for Xd"
 *   <XXXXX-XXXXX code>  (uses PUA chars for dash and zero)
 *   "Download speed: ..."
 *   "Upload speed: ..."
 *   "Data Limit: ..."
 */
export async function parseVoucherPDF(
  buffer: Buffer
): Promise<ParsedVoucherResult> {
  const errors: string[] = [];
  let rawText: string;

  try {
    const pdf = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await pdf.getText();
    rawText = result.text;
    await pdf.destroy();
  } catch (err) {
    return {
      vouchers: [],
      detected_validity: null,
      errors: [
        `Failed to parse PDF: ${err instanceof Error ? err.message : "Unknown error"}`,
      ],
    };
  }

  if (!rawText || rawText.trim().length === 0) {
    return {
      vouchers: [],
      detected_validity: null,
      errors: ["PDF contains no readable text. It may be image-based."],
    };
  }

  // Normalise PUA chars → standard ASCII before any parsing
  const text = normalisePdfText(rawText);

  // ── Extract voucher codes ──
  const codes = new Set<string>();

  // Strategy 1: Standard XXXXX-XXXXX pattern (works after PUA normalisation)
  const dashRegex = /\b(\d{5}-\d{5})\b/g;
  let match: RegExpExecArray | null;
  while ((match = dashRegex.exec(text)) !== null) {
    codes.add(match[1]);
  }

  // Strategy 2: Line-based fallback — standalone digit strings (5-10 digits)
  // that didn't already get caught. Formats 10-digit strings as XXXXX-XXXXX.
  const lines = text.split("\n").map((l) => l.trim());
  for (const line of lines) {
    if (/^\d{10}$/.test(line)) {
      codes.add(`${line.slice(0, 5)}-${line.slice(5)}`);
    } else if (/^\d{5,9}$/.test(line)) {
      // Shorter codes — store raw (text extraction was lossy)
      codes.add(line);
    }
  }

  if (codes.size === 0) {
    errors.push(
      "No voucher codes found. Expected XXXXX-XXXXX format or digit sequences."
    );
  }

  // ── Detect validity period ──
  // Pattern: "Valid for 1d", "valid for 30d", "Valid for 356d"
  let detected_validity: number | null = null;
  const validityRegex = /valid\s+for\s+(\d+)\s*d/gi;
  const validityMatch = validityRegex.exec(text);

  if (validityMatch) {
    detected_validity = parseInt(validityMatch[1], 10);
  }

  // Try alternate patterns: "1 Day", "30 Days", "365 days"
  if (detected_validity === null) {
    const altRegex = /(\d+)\s*day(?:s)?/gi;
    const altMatch = altRegex.exec(text);
    if (altMatch) {
      detected_validity = parseInt(altMatch[1], 10);
    }
  }

  // ── Extract speed/data limits as metadata ──
  const metadata: Record<string, unknown> = {};

  const speedLine = text.match(/download\s+speed:\s*(.+)/i);
  if (speedLine) {
    metadata.download_speed = speedLine[1].trim();
  }
  const uploadLine = text.match(/upload\s+speed:\s*(.+)/i);
  if (uploadLine) {
    metadata.upload_speed = uploadLine[1].trim();
  }
  const dataLine = text.match(/data\s+limit:\s*(.+)/i);
  if (dataLine) {
    metadata.data_limit = dataLine[1].trim();
  }

  const vouchers = Array.from(codes).map((code) => ({
    voucher_code: code,
    metadata: { ...metadata },
  }));

  return {
    vouchers,
    detected_validity,
    errors,
  };
}
