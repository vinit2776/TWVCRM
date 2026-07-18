/**
 * Trilingual (English / Tamil script / Tanglish) rule-based classifier for
 * facility work order titles + descriptions. Pure and synchronous — no
 * network call, safe to run on every keystroke client-side and again,
 * authoritatively, on the server at create time.
 *
 * Why rules instead of an LLM call: Phase 0 production analysis
 * (docs/plans/facility-smart-routing-phase0-findings.md) found ~20% of real
 * work orders misrouted to IT purely because the scope picker pre-highlighted
 * IT and nobody touched it — not a vocabulary problem an LLM solves better,
 * and the seed vocabulary below is pulled directly from that same analysis.
 * A rule table also matches Tamil/Tanglish without a translation round trip
 * on the create critical path (see docs/plans/facility-smart-routing.md,
 * "the classifier is language-agnostic by construction").
 */

import type { FacilityIssuePriority, FacilityScope } from "@/types";

export type DetectedLanguage = "en" | "ta" | "tanglish" | "mixed";
export type TitleQuality = "ok" | "vague";

export interface ClassifyResult {
  scope?: FacilityScope;
  confidence: number; // 0-1. Below CONFIDENCE_THRESHOLD, `scope` is omitted entirely.
  matchedTerms: string[];
  categorySlug?: string; // only populated when scope resolves to one with a 1:1 or sub category (it/hvac/electrical/facility)
  priorityFloor?: FacilityIssuePriority; // minimum priority suggested by safety/outage language in the text
  titleQuality: TitleQuality;
  detectedLanguage: DetectedLanguage;
}

interface ScopeRule {
  scope: FacilityScope;
  weight: number;
  patterns: string[];
}

interface CategoryRule {
  slug: string;
  weight: number;
  patterns: string[];
}

const CONFIDENCE_THRESHOLD = 0.4;

// ── Normalization ──────────────────────────────────────────────────────────
// Lowercase, strip Latin combining diacritics, collapse punctuation to
// whitespace. \p{L}/\p{N} cover Tamil letters, but Tamil dependent vowel
// signs (e.g. the ெ/ா/ி in குளிரவில்லை) are Unicode category Mark (\p{M}),
// not Letter — \p{M} must stay in the keep-set or Tamil text gets silently
// mangled and every Tamil-script pattern below stops matching. Padded with a
// leading/trailing space so patterns ending at a word boundary (e.g. "ac ")
// still match when that word is the very first/last token in the string.
function normalize(text: string): string {
  return (
    " " +
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim() +
    " "
  );
}

const TAMIL_SCRIPT_RE = /[஀-௿]/;

// Common Tanglish (Tamil typed in Roman script) tokens, used only to detect
// language — not for scope routing, which lists Tanglish terms per-rule below.
const TANGLISH_HINTS = [
  "illa", "iruku", "irukku", "panunga", "pannunga", "velaila", "velela",
  "venum", "aaguthu", "agudhu", "nalla", "seri", "sari", "vandhu", "pochu",
  "poidchu", "ille", "aachu", "mudiyala", "solla", "ipo", "ippo", "thanda",
  "pannala", "eriyala", "kekkala",
];

function detectLanguage(normalized: string): DetectedLanguage {
  const hasTamilScript = TAMIL_SCRIPT_RE.test(normalized);
  const hasTanglish = TANGLISH_HINTS.some((h) => normalized.includes(h));
  const hasLatinWords = /[a-z]{3,}/.test(normalized);
  if (hasTamilScript && hasLatinWords) return "mixed";
  if (hasTamilScript) return "ta";
  if (hasTanglish) return "tanglish";
  return "en";
}

// ── Scope rules ─────────────────────────────────────────────────────────────
// Every rule lists English, Tamil script, and Tanglish forms together.
// Weighted, not first-match, so e.g. "power socket sparking" scores
// Electrical higher than HVAC even though "power" alone is generic.
// Seed vocabulary pulled directly from Phase 0's real (non-test) tickets.
const SCOPE_RULES: ScopeRule[] = [
  // IT
  { scope: "it", weight: 3, patterns: [
    "wifi", "wi fi", "internet", "network", "lan", "vlan", "router", "switch",
    "server", "nvr", "cctv camera", "kiosk pc", "laptop", "desktop", "printer",
    "print", "toner", "paper jam", "password reset", "vc laptop", "hdmi",
    "isp", "latency", "biometric", "access reader", "door access", "app error",
    "notification", "wifi ஸ்பீட்", "இணையம்", "நெட்வொர்க்",
    "net illa", "wifi velaila", "net velaila", "wifi varala",
  ] },
  { scope: "it", weight: 2, patterns: ["asset", "network devices", "end devices", "diagram", "gateway"] },

  // HVAC
  { scope: "hvac", weight: 3, patterns: [
    "ac not cooling", "ac cooling", "aircon", "air conditioner", "cassette ac",
    "not cold", "ac noise", "ac leak", "ac drain", "thermostat",
    "ஏசி", "குளிரவில்லை", "ஏசி வேலை",
    "ac thanda", "thanda pannala", "ac velaila", "ac ille",
  ] },
  { scope: "hvac", weight: 2, patterns: ["ac ", "hvac", "cooling", "ventilation"] },

  // Electrical
  { scope: "electrical", weight: 3, patterns: [
    "light not working", "light not", "bulb", "tube light", "fused", "mcb",
    "socket", "plug not working", "power point", "short circuit", "tripped",
    "sparking", "spark", "wiring", "switch board", "no power", "voltage",
    "வெளிச்சம் இல்லை", "மின்சாரம் இல்லை", "பிளக்",
    "light eriyala", "current illa", "light velaila", "plug velaila",
  ] },
  { scope: "electrical", weight: 2, patterns: ["wall mounted fan", "fan issue", "electrical"] },

  // Plumbing
  { scope: "plumbing", weight: 3, patterns: [
    "water leak", "leakage", "leaking", "tap ", "faucet", "pipe burst",
    "drain block", "clogged", "toilet flush", "flush not working", "sewage",
    "restroom water", "washroom leak",
    "தண்ணீர் லீக்", "பைப் லீக்", "கழிவறை",
    "thanni leak", "thanni varala", "pipe leak aaguthu",
  ] },
  // Deliberately no bare "restroom"/"washroom"/"bathroom" rule — those are
  // location nouns, not fault signals, and over-trigger on non-plumbing
  // problems that merely happen to be located there (e.g. "Restroom Door").

  // Housekeeping
  { scope: "housekeeping", weight: 3, patterns: [
    "cleaning", "dust", "not cleaned", "trash", "garbage", "dustbin",
    "mopping", "sweeping", "smell", "bad odour", "bad odor", "stain",
    "சுத்தம் இல்லை", "தூசி",
    "cleaning pannala", "suthama illa", "dust irukku",
  ] },

  // Security
  { scope: "security", weight: 3, patterns: [
    "cctv not working", "camera not working", "guard", "unauthorized",
    "intruder", "theft", "missing item", "stolen", "gate not locking",
    "id card", "visitor pass",
    "பாதுகாப்பு", "காவலர்",
    "security velaila", "guard illa",
  ] },

  // Other
  { scope: "other", weight: 2, patterns: [
    "qr code", "sticker", "signage", "name board", "notice board",
  ] },

  // Facility (catch-all physical/furniture/civil — scored last, lower weight
  // so it doesn't outcompete a more specific scope on shared words like "broken")
  { scope: "facility", weight: 3, patterns: [
    "chair", "table broken", "handle broken", "door stopper", "cabin door",
    "ceiling", "wall hole", "hole", "floor damage", "pedestal fan", "furniture",
    "cabinet", "workstation broken",
    "நாற்காலி", "மேசை உடைந்தது",
    "chair broken irukku", "table damage aachu",
  ] },
  { scope: "facility", weight: 1, patterns: ["broken", "damage", "repair", "not working"] },
];

// ── Facility sub-category rules ─────────────────────────────────────────────
// Only meaningful when the winning scope is 'facility' — the three seeded
// facility_asset_categories (group-furniture / group-equipment / group-others).
// Plumbing/housekeeping/security/other have no category row today (see
// facility-smart-routing.md), so categorySlug stays unset for those scopes.
const FACILITY_CATEGORY_RULES: CategoryRule[] = [
  { slug: "group-furniture", weight: 3, patterns: [
    "chair", "table", "cabinet", "workstation", "desk", "handle broken",
    "நாற்காலி", "மேசை",
  ] },
  { slug: "group-equipment", weight: 3, patterns: [
    "fan", "pedestal fan", "wall mounted fan", "equipment", "printer stand",
    "மின்விசிறி",
  ] },
  { slug: "group-others", weight: 1, patterns: [
    "door", "ceiling", "wall", "floor", "hole", "stopper", "cleaning",
  ] },
];

const SCOPE_CATEGORY_SLUG: Partial<Record<FacilityScope, string>> = {
  it: "group-it",
  hvac: "group-hvac",
  electrical: "group-electrical",
  // facility resolved via FACILITY_CATEGORY_RULES below, not a fixed 1:1 slug
};

// ── Priority floor ──────────────────────────────────────────────────────────
// Safety/outage language that should suggest raising priority regardless of
// what the reporter picked. Deliberately narrow — false positives here erode
// trust in the nudge fast.
const CRITICAL_FLOOR_PATTERNS = [
  "fire", "smoke", "spark", "sparking", "short circuit", "shock", "gas leak",
  "flooding", "flooded", "no power", "power outage", "ceiling collapse",
  "தீ", "புகை", "மின்சாரம் அதிர்ச்சி",
];
const HIGH_FLOOR_PATTERNS = [
  "internet completely down", "server down", "network down", "all computers",
  "water leak", "leaking badly", "security", "theft", "stolen",
];

function computePriorityFloor(normalized: string): FacilityIssuePriority | undefined {
  if (CRITICAL_FLOOR_PATTERNS.some((p) => normalized.includes(p))) return "critical";
  if (HIGH_FLOOR_PATTERNS.some((p) => normalized.includes(p))) return "high";
  return undefined;
}

// ── Title quality ────────────────────────────────────────────────────────────
const VAGUE_TITLES = new Set([
  "test", "issue", "problem", "not working", "broken", "help", "urgent",
  "please help", "not working properly", "fix this", "error",
]);
const FILLER_WORDS = new Set([
  "the", "a", "an", "is", "are", "not", "working", "issue", "problem",
  "please", "fix", "help", "with", "in", "at", "on", "of", "and",
]);

function assessTitleQuality(normalizedTitle: string): TitleQuality {
  const trimmed = normalizedTitle.trim();
  if (VAGUE_TITLES.has(trimmed)) return "vague";
  const meaningfulWords = trimmed
    .split(" ")
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w));
  return meaningfulWords.length === 0 ? "vague" : "ok";
}

// ── Main entry point ────────────────────────────────────────────────────────
export function classify(title: string, description?: string | null, assetScope?: FacilityScope): ClassifyResult {
  const normalizedTitle = normalize(title || "");
  const combined = normalize(`${title || ""} ${description || ""}`);

  const scores = new Map<FacilityScope, { score: number; matched: Set<string> }>();
  for (const rule of SCOPE_RULES) {
    for (const pattern of rule.patterns) {
      if (combined.includes(pattern)) {
        const entry = scores.get(rule.scope) ?? { score: 0, matched: new Set<string>() };
        entry.score += rule.weight;
        entry.matched.add(pattern);
        scores.set(rule.scope, entry);
      }
    }
  }

  // Asset-derived scope is a soft prior, not a rule match — nudges a close
  // call rather than overriding a strong content signal in the other direction.
  if (assetScope) {
    const entry = scores.get(assetScope) ?? { score: 0, matched: new Set<string>() };
    entry.score += 1;
    scores.set(assetScope, entry);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [top, second] = ranked;

  let scope: FacilityScope | undefined;
  let confidence = 0;
  let matchedTerms: string[] = [];

  if (top && top[1].score > 0 && top[1].score !== second?.[1].score) {
    scope = top[0];
    matchedTerms = [...top[1].matched];
    confidence = Math.min(0.97, top[1].score / (top[1].score + 2));
    if (confidence < CONFIDENCE_THRESHOLD) {
      scope = undefined;
      matchedTerms = [];
      confidence = 0;
    }
  }

  let categorySlug: string | undefined;
  if (scope === "facility") {
    const catScores = new Map<string, number>();
    for (const rule of FACILITY_CATEGORY_RULES) {
      for (const pattern of rule.patterns) {
        if (combined.includes(pattern)) {
          catScores.set(rule.slug, (catScores.get(rule.slug) ?? 0) + rule.weight);
        }
      }
    }
    const rankedCats = [...catScores.entries()].sort((a, b) => b[1] - a[1]);
    categorySlug = rankedCats[0]?.[0];
  } else if (scope) {
    categorySlug = SCOPE_CATEGORY_SLUG[scope];
  }

  return {
    scope,
    confidence,
    matchedTerms,
    categorySlug,
    priorityFloor: computePriorityFloor(combined),
    titleQuality: assessTitleQuality(normalizedTitle),
    detectedLanguage: detectLanguage(combined),
  };
}
