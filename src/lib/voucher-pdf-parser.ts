export interface ParsedVoucherResult {
  vouchers: Array<{ voucher_code: string; metadata: Record<string, unknown> }>;
  detected_validity: number | null;
  errors: string[];
}

/**
 * WiFi system PDFs use a custom font that maps certain characters to
 * Private Use Area (PUA) Unicode codepoints:
 *
 *   U+E088 → "-" (dash between the two 5-digit halves)
 *   U+E06B → "0" (digit zero)
 */
function normalisePdfText(raw: string): string {
  return raw.replace(/\uE088/g, "-").replace(/\uE06B/g, "0");
}

/**
 * Parses a PDF buffer containing WiFi vouchers.
 *
 * Uses `unpdf` (serverless-compatible PDF.js redistribution) to extract
 * text, then decodes PUA font-encoded characters and extracts voucher
 * codes in XXXXX-XXXXX format.
 */
export async function parseVoucherPDF(
  buffer: Buffer
): Promise<ParsedVoucherResult> {
  const errors: string[] = [];
  let rawText: string;

  try {
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(buffer));
    rawText = Array.isArray(result.text)
      ? result.text.join("\n")
      : String(result.text);
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
  const lines = text.split("\n").map((l) => l.trim());
  for (const line of lines) {
    if (/^\d{10}$/.test(line)) {
      codes.add(`${line.slice(0, 5)}-${line.slice(5)}`);
    } else if (/^\d{5,9}$/.test(line)) {
      codes.add(line);
    }
  }

  if (codes.size === 0) {
    errors.push(
      "No voucher codes found. Expected XXXXX-XXXXX format or digit sequences."
    );
  }

  // ── Detect validity period ──
  let detected_validity: number | null = null;
  const validityRegex = /valid\s+for\s+(\d+)\s*d/gi;
  const validityMatch = validityRegex.exec(text);

  if (validityMatch) {
    detected_validity = parseInt(validityMatch[1], 10);
  }

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
