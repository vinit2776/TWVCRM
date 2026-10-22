import Anthropic from "@anthropic-ai/sdk";
import { unsupportedTerms } from "./unsupported-terms";
import { modelAdditions } from "./supported-items";

// Drafts a customer-specific contract clause and independently verifies it.
// Unlike the internal-note check this FAILS CLOSED: a clause that was not
// vetted must never reach an agreement, so any outage throws SpecialClauseAiError.

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MODEL = () => process.env.ANTHROPIC_SPECIAL_CLAUSE_MODEL || DEFAULT_MODEL;
const TIMEOUT_MS = 30_000;
export const MAX_ROUNDS = 3;

export class SpecialClauseAiError extends Error {}

export interface ClauseContext {
  /** Printed clause number, e.g. 37. Null when each document prints its own heading (virtual office). */
  clauseNumber: number | null;
  /** Real contract facts the clause must not contradict (rent, term, lock-in…). */
  facts: Record<string, string>;
  /** Titles of the fixed clauses already in the agreement. */
  fixedClauseTopics: string[];
}

export interface DraftInput {
  intent: string;
  reason: string;
  context: ClauseContext;
  /** Approver's feedback on a previous revision, when resubmitting. */
  feedback?: string;
  previousText?: string;
  /** The author chose to skip questions. Claude fills small gaps itself, but
   *  every term it adds is listed in report.added for the approver. Meaning
   *  errors and conflicts with fixed clauses are still enforced. */
  relaxed?: boolean;
}

export interface ClauseReport {
  restated_intent: string;
  kept: string[];
  /** Things the draft says that the author did not ask for — the approver must see these. */
  added: string[];
  topics_checked: string[];
  rounds: number;
  /** True when the author skipped the questions; the approver should read "added" closely. */
  relaxed?: boolean;
}

export type DraftResult =
  | { status: "questions"; questions: string[] }
  | { status: "drafted"; clause_text: string; report: ClauseReport }
  | { status: "failed"; problems: string[] };

export type ModelCall = (system: string, user: string) => Promise<string>;

const DRAFT_SYSTEM = `You draft ONE special clause for a single customer's coworking / virtual-office agreement in India, on behalf of The WorkVilla (the "Company"); the customer is the "Member".

Principles:
- Understand WHY the clause is wanted before writing. If the request is ambiguous or missing a figure, date, scope or consequence that changes its meaning, do NOT guess: return questions instead.
- Say only what the author asked for. Do not add anything about payment, billing, invoicing, due dates, time limits or notice unless they stated it. Do not add obligations, limits, conditions, deadlines, booking or approval rules, transfer or assignment restrictions, carry-forward rules, fees or remedies they did not state, even when they seem sensible. The clause may stay silent on anything not requested; the rest of the agreement governs.
- If a missing detail would change what the clause means for either party (for example: what happens to unused hours, what happens beyond a quota, a start or end date, whether something is free or only discounted), ask about it in "questions" instead of filling the gap yourself. Ask at most 3 short, specific questions. If nothing material is missing, draft without asking.
- Use formal, plain contract English: "The Member shall…", "The Company shall…", numbers in words and figures, defined terms "Member", "Company", "Premises", "Term". One focused paragraph; no headings except the clause title.
- Do not restate, override or contradict the fixed clauses or the contract facts given. If the request conflicts with them, return questions explaining the conflict.
- If a clause number is given, begin with that number and the title, e.g. "37. Special Conditions." If none is given, write only the operative paragraph with no number or title.

Respond with ONLY JSON:
{"questions": string[], "restated_intent": string, "clause_text": string, "kept": string[], "added": string[]}
Use "questions" (non-empty) and an empty clause_text when you cannot draft safely; otherwise leave questions empty. "kept" lists the facts from the request that the clause preserves: at most 5 items, each under 10 words. "added" must always be an empty array: if you feel the clause needs something the author did not state, ask about it in "questions" instead.`;

const RELAXED_DRAFT_ADDENDUM = `

RELAXED MODE: the author has chosen to skip clarifying questions, so do NOT return questions. Take the most reasonable reading of the request and, where a detail is missing, fill the gap with short, standard, balanced wording. The rule against adding terms is lifted for this draft on one condition: list every term you added that has no basis anywhere in the request (including the author's answers) in "added", so the approver can check it. Restating or rephrasing something the author said, and routine wording such as "during the Term" or "the Member shall", is NOT an addition. Write each item as a plain phrase under 12 words with no commentary, at most 4 items. Meaning must still match the request exactly, and nothing may conflict with the contract facts or fixed clauses.`;

const draftSystem = (relaxed?: boolean) => (relaxed ? DRAFT_SYSTEM + RELAXED_DRAFT_ADDENDUM : DRAFT_SYSTEM);

const VERIFY_SYSTEM = `You are a meticulous contract reviewer checking a drafted special clause against what the author actually asked for. Be strict; a wrong meaning in a signed agreement is costly.

Check every item:
1. Meaning preserved: every figure, date, scope and party matches the request; nothing reversed or softened.
2. Nothing beyond the request. Go through the clause one sentence at a time and find what in the request supports it. Any new obligation, limit, condition, deadline, booking or transfer rule, number or remedy is an addition, even a sensible one. Payment, billing, invoicing, due dates, time limits, notice periods and rates are additions unless the author stated them. List each in both "problems" and "unlisted_additions". Restating or rephrasing something the author said (including their answers), and routine wording such as "during the Term", is NOT an addition. Write each item as a plain phrase under 12 words with no commentary.
3. No conflict with the contract facts or the fixed clause topics (payment, use of premises, termination, liability, governing law, deposit, lock-in, notice).
4. Unambiguous, enforceable wording; no one-sided surprise for either party.
5. Numbered and titled as instructed (or carrying no number or title when none was given).

Respond with ONLY JSON: {"ok": boolean, "problems": string[], "unlisted_additions": string[], "topics_checked": string[]}
"problems" must be specific and fixable. "unlisted_additions" lists new commitments in the clause that the draft's "added" list omitted. ok is true only when problems is empty. "topics_checked" has at most 6 items, each under 8 words.`;

const RELAXED_VERIFY_NOTE = `

RELAXED MODE: the author allowed the drafter to fill small gaps. Do NOT count additions as problems; list each new commitment that has no basis in the request in "unlisted_additions" only (plain phrases under 12 words, no commentary, never something the author said), so the approver sees it. Everything else still applies: a changed meaning, a conflict with the contract facts or fixed clauses, or ambiguous wording is a problem.`;

function extractJson<T>(raw: string): T {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new SpecialClauseAiError("The model returned no JSON");
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    throw new SpecialClauseAiError("The model returned malformed JSON");
  }
}

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

/** Keeps the report skimmable however chatty the model is. */
const brief = (items: string[], max = 5, len = 120): string[] =>
  items.slice(0, max).map((t) => (t.length > len ? `${t.slice(0, len - 1).trimEnd()}…` : t));

const removalProblems = (extras: string[]): string[] =>
  extras.map((e) => `Remove "${e}": the author did not ask for it. Leave the clause silent on it.`);

/** Anything the draft says that the author did not ask for becomes a question to
 *  the author instead of clause text, so nobody approves terms nobody requested. */
const additionQuestions = (extras: string[]): string[] =>
  extras.slice(0, 3).map((e) => `Should the clause also say: ${e}?`);

function describeContext(c: ClauseContext): string {
  const facts = Object.entries(c.facts).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const number = c.clauseNumber === null ? "none (do not number or title the clause)" : String(c.clauseNumber);
  return `Clause number: ${number}\nContract facts:\n${facts}\nFixed clauses already in the agreement: ${c.fixedClauseTopics.join("; ")}`;
}

function draftPrompt(input: DraftInput, problems: string[], lastText: string | null): string {
  const parts = [
    describeContext(input.context),
    `Author's request: ${input.intent}`,
    `Why it is needed (internal): ${input.reason}`,
  ];
  if (input.feedback) parts.push(`Approver feedback on the previous revision (must be addressed): ${input.feedback}`);
  if (input.previousText) parts.push(`Previous revision text: ${input.previousText}`);
  if (lastText && problems.length) {
    parts.push(`Your last draft:\n${lastText}\nA reviewer found these problems; fix all of them:\n- ${problems.join("\n- ")}`);
  } else if (problems.length) {
    parts.push(`Instruction:\n- ${problems.join("\n- ")}`);
  }
  return parts.join("\n\n");
}

export async function draftSpecialClause(input: DraftInput, call: ModelCall = anthropicCall): Promise<DraftResult> {
  let problems: string[] = [];
  let lastText: string | null = null;
  let kept: string[] = [];
  let restated = "";

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const draftRaw: string = await call(draftSystem(input.relaxed), draftPrompt(input, problems, lastText));
    const drafted = extractJson<{
      questions?: unknown; restated_intent?: unknown; clause_text?: unknown; kept?: unknown; added?: unknown;
    }>(draftRaw);

    const questions = strArr(drafted.questions);
    if (questions.length > 0) {
      if (!input.relaxed) return { status: "questions", questions };
      // Relaxed means no questions: make it draft on its best reading instead.
      if (round === MAX_ROUNDS) throw new SpecialClauseAiError("Claude kept asking questions. Describe the request in more detail and try again.");
      problems = ["Do not ask questions. Draft now on the most reasonable reading and list any gap you filled under added."];
      continue;
    }

    const text: string = typeof drafted.clause_text === "string" ? drafted.clause_text.trim() : "";
    if (!text) throw new SpecialClauseAiError("The model returned an empty clause");
    lastText = text;
    kept = strArr(drafted.kept);
    // Backstop that does not rely on the model: payment/billing/timing wording the author never used.
    const request = [input.intent, input.feedback].filter(Boolean).join("\n");
    const draftExtras = [...modelAdditions(strArr(drafted.added), request), ...unsupportedTerms(text, request)];
    // Relaxed mode discloses additions to the approver instead of removing them.
    const disclosed: string[] = input.relaxed ? [...draftExtras] : [];
    restated = typeof drafted.restated_intent === "string" ? drafted.restated_intent : input.intent;

    // The draft itself admits to additions: no need to spend a review on it.
    if (!input.relaxed && draftExtras.length > 0) {
      if (round === MAX_ROUNDS) return { status: "questions", questions: additionQuestions(draftExtras) };
      problems = removalProblems(draftExtras);
      continue;
    }

    const verdict = extractJson<{ ok?: unknown; problems?: unknown; unlisted_additions?: unknown; topics_checked?: unknown }>(
      await call(
        VERIFY_SYSTEM + (input.relaxed ? RELAXED_VERIFY_NOTE : ""),
        `${describeContext(input.context)}\n\nAuthor's request: ${input.intent}\nWhy: ${input.reason}\n\nDrafted clause:\n${text}\n\n${input.relaxed ? "The author allowed small gap-filling; disclose it." : "The author asked for nothing beyond their request."}`,
      ),
    );
    if (typeof verdict.ok !== "boolean") throw new SpecialClauseAiError("The reviewer returned no verdict");

    const found = strArr(verdict.problems);
    const unlisted = modelAdditions(strArr(verdict.unlisted_additions), request);

    if (verdict.ok && found.length === 0 && (input.relaxed || unlisted.length === 0)) {
      return {
        status: "drafted",
        clause_text: text,
        report: {
          restated_intent: restated,
          kept: brief(kept),
          added: input.relaxed ? brief([...new Set([...disclosed, ...unlisted])], 6) : [],
          topics_checked: brief(strArr(verdict.topics_checked), 6, 80),
          rounds: round,
          ...(input.relaxed ? { relaxed: true } : {}),
        },
      };
    }
    // Only additions left on the last round: hand them to the author as questions.
    if (!input.relaxed && round === MAX_ROUNDS && found.length === 0 && unlisted.length > 0) {
      return { status: "questions", questions: additionQuestions(unlisted) };
    }
    problems = [...found, ...(input.relaxed ? [] : removalProblems(unlisted))];
    if (problems.length === 0) problems = ["The reviewer rejected the draft without a reason; tighten the wording."];
  }
  return { status: "failed", problems };
}

async function anthropicCall(system: string, user: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) throw new SpecialClauseAiError("The AI review isn't set up on this server yet. Ask an admin to configure it.");
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create(
      { model: MODEL(), max_tokens: 1200, system, messages: [{ role: "user", content: user }] },
      { timeout: TIMEOUT_MS, maxRetries: 1 },
    );
    return message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  } catch (err) {
    if (err instanceof SpecialClauseAiError) throw err;
    console.error("[special-clause-ai]", err instanceof Error ? err.message : err);
    throw new SpecialClauseAiError("The AI review is unavailable right now. Try again shortly.");
  }
}
