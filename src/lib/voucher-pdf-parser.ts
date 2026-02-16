import { PDFParse } from "pdf-parse";

export interface ParsedVoucherResult {
  vouchers: Array<{ voucher_code: string; metadata: Record<string, unknown> }>;
  detected_validity: number | null;
  errors: string[];
}

/**
 * Parses a PDF buffer containing WiFi vouchers.
 * Extracts voucher codes (XXXXX-XXXXX format) and detects validity period.
 */
export async function parseVoucherPDF(
  buffer: Buffer
): Promise<ParsedVoucherResult> {
  const errors: string[] = [];
  let text: string;

  try {
    const pdf = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await pdf.getText();
    text = result.text;
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

  if (!text || text.trim().length === 0) {
    return {
      vouchers: [],
      detected_validity: null,
      errors: ["PDF contains no readable text. It may be image-based."],
    };
  }

  // Extract voucher codes: 5-digit dash 5-digit pattern
  const codeRegex = /\b(\d{5}-\d{5})\b/g;
  const codes = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = codeRegex.exec(text)) !== null) {
    codes.add(match[1]);
  }

  if (codes.size === 0) {
    errors.push(
      "No voucher codes found. Expected codes in XXXXX-XXXXX format."
    );
  }

  // Detect validity period from text like "Valid for 1d" or "valid for 30d"
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

  // Extract speed/data limits as metadata if found
  const metadata: Record<string, unknown> = {};

  // Speed patterns: "10 Mbps", "50Mbps", etc.
  const speedMatch = text.match(/(\d+)\s*(?:mbps|Mbps|MBPS)/i);
  if (speedMatch) {
    metadata.speed = `${speedMatch[1]} Mbps`;
  }

  // Data limit patterns: "1 GB", "500 MB", etc.
  const dataMatch = text.match(/(\d+)\s*(?:GB|MB|gb|mb)/);
  if (dataMatch) {
    metadata.data_limit = dataMatch[0].trim();
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
