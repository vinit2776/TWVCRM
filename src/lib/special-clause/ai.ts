import Anthropic from "@anthropic-ai/sdk";

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
}

export interface ClauseReport {
  restated_intent: string;
  kept: string[];
  /** Things the draft says that the author did not ask for — the approver must see these. */
  added: string[];
  topics_checked: string[];
  rounds: number;
}

export type DraftResult =
  | { status: "questions"; questions: string[] }
  | { status: "drafted"; clause_text: string; report: ClauseReport }
  | { status: "failed"; problems: string[] };

export type ModelCall = (system: string, user: string) => Promise<string>;

const DRAFT_SYSTEM = `You draft ONE special clause for a single customer's coworking / virtual-office agreement in India, on behalf of The WorkVilla (the "Company"); the customer is the "Member".

Principles:
- Understand WHY the clause is wanted before writing. If the request is ambiguous or missing a figure, date, scope or consequence that changes its meaning, do NOT guess: return questions instead.
- Preserve the author's meaning exactly. Never invent commitments, numbers, dates, discounts or remedies that were not stated. If a standard guard-rail seems prudent (for example no carry-forward, or what happens beyond a quota), list it under "added" so the approver sees it; do not hide it.
- Use formal, plain contract English: "The Member shall…", "The Company shall…", numbers in words and figures, defined terms "Member", "Company", "Premises", "Term". One focused paragraph; no headings except the clause title.
- Do not restate, override or contradict the fixed clauses or the contract facts given. If the request conflicts with them, return questions explaining the conflict.
- If a clause number is given, begin with that number and the title, e.g. "37. Special Conditions." If none is given, write only the operative paragraph with no number or title.

Respond with ONLY JSON:
{"questions": string[], "restated_intent": string, "clause_text": string, "kept": string[], "added": string[]}
Use "questions" (non-empty) and an empty clause_text when you cannot draft safely; otherwise leave questions empty. "kept" lists the facts from the request that the clause preserves; "added" lists anything beyond the request.`;

const VERIFY_SYSTEM = `You are a meticulous contract reviewer checking a drafted special clause against what the author actually asked for. Be strict; a wrong meaning in a signed agreement is costly.

Check every item:
1. Meaning preserved: every figure, date, scope and party matches the request; nothing reversed or softened.
2. No new obligations or numbers beyond the request, other than ones listed as "added".
3. No conflict with the contract facts or the fixed clause topics (payment, use of premises, termination, liability, governing law, deposit, lock-in, notice).
4. Unambiguous, enforceable wording; no one-sided surprise for either party.
5. Numbered and titled as instructed (or carrying no number or title when none was given).

Respond with ONLY JSON: {"ok": boolean, "problems": string[], "unlisted_additions": string[], "topics_checked": string[]}
"problems" must be specific and fixable. "unlisted_additions" lists new commitments in the clause that the draft's "added" list omitted. ok is true only when problems is empty.`;

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
  }
  return parts.join("\n\n");
}

export async function draftSpecialClause(input: DraftInput, call: ModelCall = anthropicCall): Promise<DraftResult> {
  let problems: string[] = [];
  let lastText: string | null = null;
  let kept: string[] = [];
  let added: string[] = [];
  let restated = "";

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const draftRaw: string = await call(DRAFT_SYSTEM, draftPrompt(input, problems, lastText));
    const drafted = extractJson<{
      questions?: unknown; restated_intent?: unknown; clause_text?: unknown; kept?: unknown; added?: unknown;
    }>(draftRaw);

    const questions = strArr(drafted.questions);
    if (questions.length > 0) return { status: "questions", questions };

    const text: string = typeof drafted.clause_text === "string" ? drafted.clause_text.trim() : "";
    if (!text) throw new SpecialClauseAiError("The model returned an empty clause");
    lastText = text;
    kept = strArr(drafted.kept);
    added = strArr(drafted.added);
    restated = typeof drafted.restated_intent === "string" ? drafted.restated_intent : input.intent;

    const verdict = extractJson<{ ok?: unknown; problems?: unknown; unlisted_additions?: unknown; topics_checked?: unknown }>(
      await call(
        VERIFY_SYSTEM,
        `${describeContext(input.context)}\n\nAuthor's request: ${input.intent}\nWhy: ${input.reason}\n\nDrafted clause:\n${text}\n\nDraft's own "added" list: ${JSON.stringify(added)}`,
      ),
    );
    if (typeof verdict.ok !== "boolean") throw new SpecialClauseAiError("The reviewer returned no verdict");

    const found = strArr(verdict.problems);
    const unlisted = strArr(verdict.unlisted_additions);
    // Unlisted additions are never fatal: surface them to the approver rather than loop on them.
    for (const u of unlisted) if (!added.includes(u)) added.push(u);

    if (verdict.ok && found.length === 0) {
      return {
        status: "drafted",
        clause_text: text,
        report: {
          restated_intent: restated,
          kept,
          added,
          topics_checked: strArr(verdict.topics_checked),
          rounds: round,
        },
      };
    }
    problems = found.length ? found : ["The reviewer rejected the draft without a reason; tighten the wording."];
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
