// The model sometimes lists, under "added", things the author did say (forfeiting
// unused hours, "during the Term") and pads items with commentary like "(not
// specified in request)". The approver then reads warnings that aren't true. This
// keeps only items whose substance has little basis in the request, so the list
// stays short and means what it says.

const STOP = new Set([
  "that", "this", "with", "from", "have", "will", "shall", "must", "were", "been", "being", "than", "then", "also",
  "such", "each", "every", "other", "which", "their", "there", "these", "those", "into", "over", "upon", "under",
  "your", "only", "same", "does", "should", "would", "could", "about", "after", "before", "where", "when", "while",
  "clause", "request", "specified", "stated", "implicit", "member", "company", "agreement", "premises", "term", "terms",
]);

const stem = (w: string) => w.slice(0, 5);

function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOP.has(w)) out.add(stem(w));
  }
  return out;
}

/** Drops the model's commentary and trailing fragments so each item reads as one plain phrase. */
export function cleanItem(item: string): string {
  const noParens = item.replace(/\s*\([^)]*\)?/g, " ").replace(/\s+/g, " ").trim();
  const noEllipsis = noParens.replace(/[…]+$|\.{3,}$/g, "").trim();
  return noEllipsis.length > 100 ? `${noEllipsis.slice(0, 99).trimEnd()}…` : noEllipsis;
}

/** Wording every clause has ("during the Term"), never a substantive addition. */
const ROUTINE = /\b(?:during|throughout)\s+(?:the\s+)?(?:contract\s+)?term\b|\b(?:applies|operates|runs|effective|valid)\b.*\bterm\b/i;
const isRoutine = (text: string) => ROUTINE.test(text.replace(/[\u2018\u2019\u201C\u201D'"]/g, ""));

const SUPPORTED_AT = 0.5;
const DUPLICATE_AT = 0.7;

/** Items from the model that the request does NOT already cover, cleaned and de-duplicated. */
export function modelAdditions(items: string[], request: string): string[] {
  const req = stems(request);
  const kept: { text: string; stems: Set<string> }[] = [];
  for (const raw of items) {
    const text = cleanItem(raw);
    const s = stems(text);
    if (s.size === 0 || isRoutine(text)) continue;
    const covered = [...s].filter((x) => req.has(x)).length / s.size;
    if (covered >= SUPPORTED_AT) continue;
    const duplicate = kept.some((k) => [...s].filter((x) => k.stems.has(x)).length / Math.min(s.size, k.stems.size) >= DUPLICATE_AT);
    if (!duplicate) kept.push({ text, stems: s });
  }
  return kept.map((k) => k.text);
}
