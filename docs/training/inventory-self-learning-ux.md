# Self-Learning UI/UX — Inventory / Transfers / Consumption

Suggestions to make the module **teach itself** as people use it, so onboarding leans less on documents. Grounded in the current screens. Ordered by impact-to-effort.

Legend: **Impact** (★ low → ★★★ high) · **Effort** (S/M/L)

---

## Already in place (build on these)
- The **Consumption wizard** has a coach-mark ("CONSUMPTION 1/2 — Record daily consumption…"). Good pattern — extend it to the other screens.
- The new **Transfer progress stepper** is itself a self-learning aid: it shows what has happened and what's next. Reuse the same "next action" phrasing elsewhere.
- Clean **empty states** already exist (e.g. "No inventory at this location. Stock arrives via purchase orders or transfers.").

---

## High-value, low-effort

1. **Action buttons that explain their consequence.** ★★★ · S
   Add a one-line tooltip / helper under each transfer action:
   - *Mark Dispatched* → "Removes stock from the source location now."
   - *Receive* → "Adds the received quantity to this location."
   - *Void* (consumption) → "Cancels the log and puts all stock back."
   Users learn the side-effects without trial and error.

2. **Tooltips on status badges.** ★★ · S
   Hovering **Low** / **Out** / **OK** (Inventory) and the transfer status pills explains what they mean and what to do ("Low — at/below reorder level; plan to reorder").

3. **Reorder threshold made visible inline.** ★★ · S
   On Inventory rows, show "12 / reorder 15" together so the relationship is obvious, and colour the number when at/below reorder.

4. **"What can I do here?" line under each page title.** ★★ · S
   One sentence per page ("Transfers move stock between locations. Create → approve → dispatch → receive."). Cheap orientation for first-time users.

---

## High-value, medium-effort

5. **First-run coach marks per screen.** ★★★ · M
   Extend the wizard's coach-mark to Inventory and Transfers: a 2–3 step highlighted tour on first visit ("This is your location picker", "This badge means stock is low"), dismissible and replayable from a "?" button.

6. **Contextual empty/edge-state guidance.** ★★ · M
   - Consumption Pick-Items empty → add a button "See how stock arrives" linking to a short explainer.
   - Inventory all-OK → a subtle "Everything's stocked 👍" rather than a blank table.

7. **Inline "next step" nudges on Transfers list.** ★★ · M
   Show each transfer's *next action* in the list (mirroring the stepper hint) — e.g. a small "Awaiting your approval" tag for managers — so people learn the flow by seeing where things are stuck.

8. **Confirm dialogs that teach.** ★★ · M
   Before Dispatch/Void, a confirm modal that states the effect ("This will remove 5 pieces from NUN 5th floor. Continue?"). Doubles as a safety net and a lesson.

---

## Higher-effort / longer-term

9. **A persistent "?" help drawer per module.** ★★ · L
   A slide-over with the role-relevant steps + a link to the training guide, available on every Procurement page.

10. **Guided "try it" sandbox / demo data.** ★ · L
    A toggle that loads a clearly-marked demo location so new staff can practice consumption/transfers without touching real stock. (Pairs well with the planned Inventory adjust UI.)

11. **In-context glossary.** ★ · L
    Dotted-underline key terms (challan, reorder level, dispatch, void) that pop a one-line definition on hover.

---

## Quick wins to ship first
Items **1, 2, 3, 4** are mostly tooltips/labels — a single small PR, no new infrastructure, and they remove the most common "what does this do / what do I do next" confusion. Items **5** and **8** are the next tier and give the biggest learning lift.
