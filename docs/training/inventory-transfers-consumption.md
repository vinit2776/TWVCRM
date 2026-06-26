# Inventory, Stock Transfers & Consumption — Team Training Guide

**Who this is for:** Floor managers, office admins, accounts, and managers who handle stock at any TWV location.
**Where it lives in the app:** Left sidebar → **Procurement** → *Inventory*, *Transfers*, *Consumption*.

This guide walks through the four everyday flows, who can do each step, and what happens to your stock numbers at each stage.

---

## 0. The big picture (read this first)

There are **four screens** that work together:

| Screen | What it's for | Changes stock? |
|--------|---------------|----------------|
| **Inventory** | See how much of each item is at a location | No — view only |
| **Transfers** | Move stock from one location to another | Yes — out of source, into destination |
| **Consumption** | Record daily usage of items (cleaning supplies, pantry, etc.) | Yes — reduces stock |
| **Consumption → History** | Review past usage and fix mistakes | Only when you correct an entry |

**How stock gets *into* a location:**
1. A **Purchase Order** is delivered, or
2. A **Stock Transfer** is received from another location, or
3. An admin sets it directly (today this is done by the office team; a screen to do it yourself is planned).

**How stock *leaves* a location:**
1. **Consumption** (you used it up), or
2. A **Transfer dispatched** to another location.

> Golden rule: if the number on the Inventory screen looks wrong, it's almost always because a **consumption** or a **transfer** hasn't been logged yet — log it and the number corrects itself.

---

## 1. Inventory — checking what's in stock

**Menu:** Procurement → **Inventory**

1. Pick a **location** from the dropdown (top right).
2. (Optional) Click a **department** tab — All / Pantry / Maintenance / Administration / Asset / AMC — to narrow the list.
3. (Optional) Type in **Search** to find an item by name.
4. Read the table:
   - **Qty on Hand** — how much is there right now.
   - **Reorder Level** — the minimum before you should reorder.
   - **Status** badge:
     - 🟢 **OK** — healthy stock
     - 🟡 **Low** — at or below reorder level, plan to reorder
     - 🔴 **Out** — zero in stock

> Inventory is **view-only** today. You can't type a number in here. To put stock in, use a Purchase Order or a Transfer. (A "set / adjust stock" screen is on the roadmap.)

---

## 2. Stock Transfers — moving stock between locations

**Menu:** Procurement → **Transfers**

A transfer moves through a fixed set of stages. The status badge always tells you where it is.

| Step | Who does it | What happens | New status |
|------|-------------|--------------|-----------|
| **1. Create** | Admin / Manager / Office Admin | Choose **From** location, **To** location, add items + quantities | **Draft** |
| **2. Submit** | Same | Sends it for approval | **Pending Approval** |
| **3. Approve** | Admin / Manager | App checks the *From* location has enough stock | **Approved** |
| *(or Reject)* | Admin / Manager | Sent back with a note to fix | back to **Draft** |
| **4. Dispatch** | Admin / Manager / Office Admin | **Stock is removed from the *From* location** | **Dispatched** |
| **5. Receive** | Receiving staff | Enter the quantity actually received for each item. **Stock is added to the *To* location** | **Completed** (all matched) or **Received** (partial) |
| **6. Report Issue** *(if needed)* | Receiving staff | Flag a shortage / excess / damage / wrong item | **Issue Raised** |
| **7. Resolve Issue** | Admin / Manager | Add a note, optionally adjust stock for a shortage | **Completed** |

### Step-by-step: creating and sending a transfer
1. Transfers → **New Transfer**.
2. Pick **From** and **To** locations (they must be different).
3. Add each item and the **quantity to send**. Save → it's a **Draft**.
4. Click **Submit** → status becomes **Pending Approval**.
5. A manager opens it and clicks **Approve** (or **Reject** with a reason).
6. When ready to physically send it, click **Dispatch** — *this is the moment stock leaves the source location.*

### Step-by-step: receiving a transfer
1. Open the dispatched transfer at the destination.
2. Click **Receive** and enter the **quantity received** for each line.
   - If everything matches → status **Completed**, stock added.
   - If you received less/more → status **Received**, and you should **Report an Issue**.
3. To flag a problem: **Report Issue** → pick the type (shortage, excess, damage, wrong item, quality, other), enter the numbers and a description.
4. A manager then **Resolves** the issue (and can tick "adjust stock" to correct a shortage).

---

## 3. Consumption — logging daily usage

**Menu:** Procurement → **Consumption** (a 4-step wizard)
**Who can do it:** any logged-in staff member, for their own location.
**Language:** there's an **English / தமிழ்** toggle at the top right.

1. **Location** — choose where the items were used → **Next**.
2. **Pick Items** — only items that are *in stock at that location* appear.
   - Search or use the department tabs to find an item.
   - Use **– / +** (or type) to set the quantity used. The card shows "*N available*".
   - Add as many items as you need → **Review Cart**.
3. **Review Cart** — check the items and quantities, add an optional note → **Review & Confirm**.
4. **Confirm** — final check → **Submit Consumption**.
   - You'll see **"Consumption logged successfully"**.
   - **Stock is reduced immediately.**
   - If any item dropped to/below its reorder level, you'll see a **reorder alert** on the success screen.

> Tip: only items with stock show up in step 2. If an item is missing, it has **0 on hand** at that location — receive a transfer or PO first.

---

## 4. Corrections — fixing a consumption mistake

**Menu:** Procurement → Consumption → **History**
**Who can do it:** Admin / Manager.

1. Filter by **location / date / status**, then click a row to expand and see the items.
2. Click **Correct** and choose one of:
   - **Void** — cancels the whole entry and **puts all the stock back**. Use when the entire log was wrong.
   - **Adjust** — change one item's quantity; stock is corrected by the difference (e.g. logged 10, actually 7 → 3 go back).
   - **Re-log** — voids the original and creates a fresh, corrected entry in one step.
3. A **reason is required** — it's saved to the correction history so there's a clear audit trail of who changed what and why.

---

## 5. Roles at a glance

| Action | Who can do it |
|--------|---------------|
| View Inventory / Transfers / Consumption | All staff (their locations) |
| Create / Submit / Dispatch a transfer | Admin, Manager, Office Admin |
| Approve / Reject a transfer | Admin, Manager |
| Receive a transfer / Report an issue | Receiving staff |
| Resolve a transfer issue | Admin, Manager |
| Log consumption | All staff (their location) |
| Correct (Void / Adjust / Re-log) a consumption log | Admin, Manager |

---

## 6. Troubleshooting & FAQ

**"I logged consumption but the stock number didn't change."**
This was a known system bug and has been **fixed**. Stock now reduces the moment you submit. If you still see this, refresh the Inventory page — and report it.

**"The Consumption → History page showed an error / blank screen."**
Also a known bug, now **fixed**. History opens normally and lists past logs.

**"I couldn't report a shortage on a received transfer — it errored."**
Fixed. Reporting an issue now works and moves the transfer to **Issue Raised**.

**"I voided/corrected a log but couldn't see the correction afterwards."**
Fixed. Corrections now save and show in the log's history with the reason and who made them.

**"An item I need isn't in the Consumption list."**
It has 0 stock at that location. Bring stock in via a **received transfer** or **purchase order** first.

**"The Inventory number looks too high."**
Something used was probably not logged. Log the **consumption** (or **dispatch** the transfer) and it will correct.

---

## 7. Coming soon

- A **Set / Adjust stock** screen on the Inventory page (set opening stock, fix counts, edit reorder levels) — currently the office team does this for you.

---

*Questions or something not matching what you see? Flag it to the admin team so the guide stays accurate.*
