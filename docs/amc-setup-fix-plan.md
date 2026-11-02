# AMC set-up: fix plan for existing contracts

Why this exists: an AMC raised as a goods PO and later edited into the AMC department
reads as an AMC but has no billing cycles, so it can't log service reports or invoice by
cycle (PO-2604-044). The "Set up as AMC" wizard (PO page) fixes one at a time; this is the
order to use it in.

## 1. PO-2604-044 (Blue Star, Pycrofts Garden)

What the vendor documents show: contract 30 Mar 2026 – 29 Mar 2027, billed **half-yearly
in advance**, 4 preventive visits a year, amounts **before GST** with 18% added per invoice.
The PO is ₹20,790 before GST, so one instalment is ₹10,395; ₹10,395 + 18% = **₹12,266.10**,
which is exactly the invoice already on the PO (vendor invoice 1033015258).

Steps (admin, after migration 00654 is on production):

1. Open the PO → **Set up as AMC**.
2. Billing: **Half-Yearly, 2 cycles** (the wizard suggests this from the payment terms
   and the invoice). Check the table: cycle 1 30 Mar – 29 Sep 2026, cycle 2 30 Sep 2026 – 29 Mar 2027,
   ₹10,395 each before GST.
3. Invoice: pick **Invoice 1033015258** for cycle 1 (it should read "matches one cycle plus 18% GST").
4. Review → **Set up AMC**. Nothing about amounts, payments or the advance changes.
5. Afterwards check on the PO: type is Service, cycle 2 is due, the approved invoice
   keeps its approval and payment status.

Before step 1 on production, confirm the PO's payment terms still read "Half-Yearly".

## 2. Other AMCs that are set up badly

Run this read-only query on **production** (Supabase SQL editor) and send me the result.
It lists AMC POs by how complete they are; it changes nothing.

```sql
SELECT po.po_number, po.status, po.po_type, po.total_ordered_amount,
       po.billing_cycle, po.cycle_count, po.unit_cost_per_cycle,
       po.amc_start_date, po.amc_end_date, po.amc_terminated_at,
       CASE
         WHEN po.po_type <> 'service'                                   THEN '1 goods-type AMC: needs the wizard'
         WHEN po.billing_cycle IS NULL OR po.cycle_count IS NULL
              OR po.unit_cost_per_cycle IS NULL                          THEN '2 service but cycle fields missing'
         WHEN po.amc_start_date IS NULL OR po.amc_end_date IS NULL       THEN '3 service, contract dates missing'
         ELSE '4 set up'
       END AS bucket
FROM purchase_orders po
LEFT JOIN purchase_requests pr ON pr.id = po.pr_id
WHERE po.status NOT IN ('cancelled')
  AND (pr.department = 'amc' OR pr.expenditure_type = 'amc' OR po.amc_start_date IS NOT NULL)
ORDER BY bucket, po.po_number;
```

Then, per bucket:

- **1, goods-type AMC**: run the wizard on each, one at a time. Cycles come from what
  the vendor documents say, never from the PO total alone.
- **2 / 3, service but incomplete**: not fixable by the wizard (it only converts goods-type POs).
  List them; each needs its missing fields set on the PO's AMC panel, or an admin correction.
- **4**: leave alone.

## 3. Rules while fixing

- One PO at a time, admin only; never a bulk script against production.
- Confirm cycles against the vendor's proposal/proforma (billing frequency, period), not
  just the PO notes.
- If an invoice does not match a cycle (the wizard says so), leave it untied and ask the
  vendor which instalment it was, rather than forcing it.
- Rollback for a wrong conversion: the audit entry on the PO records every old value
  (`_conversion: goods_to_service_amc`), same as the PO-2604-045 manual conversion.
