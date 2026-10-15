-- Customer Value tab — Phase 0 data coverage check
-- Spec: docs/customer-value-tab-spec.md (section 6, "Phase 0 deliverable")
--
-- READ ONLY. Every statement is a SELECT; nothing is written, locked or sent.
-- Output is counts, dates and location names only — no customer names, phone
-- numbers, emails or MAC addresses.
--
-- Run it in the Supabase SQL editor against the project you want to measure
-- (production for real coverage; staging only proves the query works, because
-- staging holds fake seed data). It returns one result set:
--
--   area     which part of the tab depends on it
--   scope    a location, or 'ALL LOCATIONS' for the total
--   chk      what was measured
--   n        rows meeting the check
--   of_total rows considered
--   pct      n / of_total
--   note     earliest/latest dates or extra context
--
-- How to read it: a low pct, or an 'earliest' date that is recent, means that
-- chart will start thin or empty for that location. See the spec for what each
-- check gates. Checks marked (info) have no meaningful percentage.

WITH
-- 1. Contracts: journey, renewals, escalation -------------------------------
b_contracts AS (
  SELECT 1 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE COALESCE(l.name, '(no location)') END AS scope,
      count(*)                                                                           AS total,
      count(*) FILTER (WHERE c.activated_at IS NOT NULL)                                 AS act,
      count(*) FILTER (WHERE c.status = 'terminated' AND c.activated_at IS NULL)         AS withdrawn,
      count(*) FILTER (WHERE c.status IN ('active','renewal_in_progress','renewed','expired')
                         AND c.activated_at IS NULL)                                     AS ran_no_stamp,
      count(*) FILTER (WHERE c.activated_at IS NOT NULL AND c.parent_contract_id IS NOT NULL) AS renewals,
      count(*) FILTER (WHERE c.activated_at IS NOT NULL AND c.parent_contract_id IS NOT NULL
                         AND c.escalation_percentage IS NOT NULL
                         AND p.escalation_percentage IS NOT NULL)                        AS esc_both,
      count(*) FILTER (WHERE c.activated_at IS NOT NULL AND c.parent_contract_id IS NOT NULL
                         AND c.escalation_percentage < p.escalation_percentage)          AS esc_below_parent,
      count(*) FILTER (WHERE c.activated_at IS NOT NULL AND c.parent_contract_id IS NOT NULL
                         AND c.escalation_waived IS TRUE)                                AS esc_waived,
      count(*) FILTER (WHERE c.activated_at IS NOT NULL AND c.parent_contract_id IS NOT NULL
                         AND c.escalation_approval_status IS NOT NULL)                   AS esc_approval,
      min(c.activated_at)::date                                                          AS first_act
    FROM contracts c
    LEFT JOIN contracts p  ON p.id = c.parent_contract_id
    LEFT JOIN locations l  ON l.id = c.location_id
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('contracts that ever activated (activated_at set)',               g.act::bigint,          g.total::bigint,   'earliest activation: ' || COALESCE(g.first_act::text, 'none')),
    ('never-activated rows stored as terminated (to exclude)',          g.withdrawn::bigint,    g.total::bigint,   '(info) withdrawn contracts the tab must skip'),
    ('contracts that look like they ran but have no activated_at',      g.ran_no_stamp::bigint, g.total::bigint,   'must be ~0, otherwise the exclusion rule needs another test'),
    ('activated renewals (have a parent contract)',                     g.renewals::bigint,     g.act::bigint,     NULL),
    ('renewals where parent and renewal both carry an escalation %',    g.esc_both::bigint,     g.renewals::bigint,'needed to compare asked vs agreed'),
    ('renewals agreed BELOW the parent clause (negotiated)',            g.esc_below_parent::bigint, g.renewals::bigint, '(info)'),
    ('renewals with escalation waived',                                 g.esc_waived::bigint,   g.renewals::bigint,'(info)'),
    ('renewals with an escalation approval status',                     g.esc_approval::bigint, g.renewals::bigint,'(info)')
  ) v(chk, n, of_total, note)
),
-- 2. Leads: how many customers have history worth scoring ------------------
b_leads AS (
  SELECT 2 AS ord, 'ALL LOCATIONS' AS scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      count(*) FILTER (WHERE n_act >= 1)  AS with_one,
      count(*) FILTER (WHERE n_act >= 2)  AS with_two,
      count(*) FILTER (WHERE n_ren >= 1)  AS with_renewal,
      count(*)                            AS total
    FROM (
      SELECT lead_id,
             count(*) FILTER (WHERE activated_at IS NOT NULL) AS n_act,
             count(*) FILTER (WHERE activated_at IS NOT NULL AND parent_contract_id IS NOT NULL) AS n_ren
      FROM contracts
      GROUP BY lead_id
    ) x
  ) g
  CROSS JOIN LATERAL (VALUES
    ('leads with at least one activated contract', g.with_one::bigint,     g.total::bigint, 'leads that have any contract row'),
    ('leads with two or more activated contracts', g.with_two::bigint,     g.with_one::bigint, NULL),
    ('leads with at least one renewal',            g.with_renewal::bigint, g.with_one::bigint, NULL)
  ) v(chk, n, of_total, note)
),
-- 3. Invoices and payment timing -------------------------------------------
b_pay AS (
  SELECT 3 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE COALESCE(l.name, '(no location)') END AS scope,
      count(*)                                                                  AS total,
      count(*) FILTER (WHERE bs.due_date IS NOT NULL)                           AS with_due,
      count(*) FILTER (WHERE bs.payment_status = 'paid')                        AS paid,
      count(*) FILTER (WHERE bs.payment_status = 'paid'
                         AND EXISTS (SELECT 1 FROM billing_payments bp
                                     WHERE bp.billing_statement_id = bs.id
                                       AND bp.payment_date IS NOT NULL))        AS paid_dated,
      count(*) FILTER (WHERE bs.reminder_count > 0)                             AS reminded,
      min(bs.finalized_at)::date                                                AS first_stmt,
      min(bs.finalized_at) FILTER (WHERE bs.due_date IS NOT NULL)::date         AS first_with_due
    FROM billing_statements bs
    LEFT JOIN contracts c ON c.id = bs.contract_id
    LEFT JOIN locations l ON l.id = c.location_id
    WHERE bs.status NOT IN ('draft','voided')
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('issued statements that have a due_date',               g.with_due::bigint,   g.total::bigint, 'earliest statement ' || COALESCE(g.first_stmt::text,'none') || ', earliest with a due date ' || COALESCE(g.first_with_due::text,'none')),
    ('paid statements with a dated payment record',          g.paid_dated::bigint, g.paid::bigint,  'needed for days-late'),
    ('statements that needed at least one reminder',         g.reminded::bigint,   g.total::bigint, '(info)')
  ) v(chk, n, of_total, note)
),
-- 4. Seats paid for over time ----------------------------------------------
b_seats AS (
  SELECT 4 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE COALESCE(l.name, '(no location)') END AS scope,
      count(*)                                                                            AS act,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contract_space_allocations a WHERE a.contract_id = c.id)) AS with_alloc,
      (SELECT min(a2.start_date) FROM contract_space_allocations a2)                      AS first_alloc
    FROM contracts c
    LEFT JOIN locations l ON l.id = c.location_id
    WHERE c.activated_at IS NOT NULL
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('activated contracts with a space/seat allocation', g.with_alloc::bigint, g.act::bigint, 'earliest allocation in the system: ' || COALESCE(g.first_alloc::text,'none'))
  ) v(chk, n, of_total, note)
),
-- 5. Door access (seats used) ----------------------------------------------
b_door AS (
  SELECT 5 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE l.name END AS scope,
      count(*)                                                          AS ev,
      count(*) FILTER (WHERE al.user_type = 'contract' AND al.entity_id IS NOT NULL) AS ev_contract,
      count(DISTINCT al.device_id)                                      AS devs,
      min(al.event_time)::date                                          AS first_ev,
      max(al.event_time)::date                                          AS last_ev
    FROM access_logs al
    JOIN cosec_devices d ON d.id = al.device_id
    JOIN locations l     ON l.id = d.location_id
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('access events resolved to a contract', g.ev_contract::bigint, g.ev::bigint, 'history ' || COALESCE(g.first_ev::text,'none') || ' to ' || COALESCE(g.last_ev::text,'none') || ', devices with events: ' || g.devs)
  ) v(chk, n, of_total, note)
),
b_door_active AS (
  SELECT 5 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE COALESCE(l.name, '(no location)') END AS scope,
      count(*) AS cur,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM access_logs al
                                     WHERE al.entity_id = c.id
                                       AND al.event_time > now() - interval '30 days')) AS seen
    FROM contracts c
    LEFT JOIN locations l ON l.id = c.location_id
    WHERE c.status IN ('active','renewal_in_progress')
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('current contracts with door activity in the last 30 days', g.seen::bigint, g.cur::bigint, 'low % = no device, or contracts not mapped to access users')
  ) v(chk, n, of_total, note)
),
b_door_dev AS (
  SELECT 5 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE l.name END AS scope,
      count(*) FILTER (WHERE d.is_enabled) AS enabled,
      count(*)                             AS total
    FROM cosec_devices d
    JOIN locations l ON l.id = d.location_id
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('door devices enabled', g.enabled::bigint, g.total::bigint, '(info) a location with 0 has no seats-used signal')
  ) v(chk, n, of_total, note)
),
-- 6. Tickets: can they be tied to a customer, and are hours logged ---------
b_tix AS (
  SELECT 6 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE COALESCE(l.name, '(no location)') END AS scope,
      count(*)                                                                   AS total,
      count(*) FILTER (WHERE fi.space_unit_id IS NOT NULL)                       AS with_unit,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM contract_space_allocations a
        WHERE a.space_unit_id = fi.space_unit_id
          AND fi.created_at::date >= a.start_date
          AND (a.end_date IS NULL OR fi.created_at::date <= a.end_date)))        AS linkable,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM facility_issue_time_logs t WHERE t.issue_id = fi.id)) AS with_hours,
      min(fi.created_at)::date                                                   AS first_tix
    FROM facility_issues fi
    LEFT JOIN locations l ON l.id = fi.location_id
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('tickets that name a space unit',                                g.with_unit::bigint,  g.total::bigint, 'earliest ticket ' || COALESCE(g.first_tix::text,'none')),
    ('tickets that can be linked to a customer via a dated allocation', g.linkable::bigint, g.total::bigint, 'the share the tab can attribute'),
    ('tickets with at least one logged time entry',                   g.with_hours::bigint, g.total::bigint, 'needed for staff-time cost')
  ) v(chk, n, of_total, note)
),
-- 7. Wi-Fi: vouchers, members, UniFi-enabled locations ---------------------
b_wifi_loc AS (
  SELECT 7 AS ord, 'ALL LOCATIONS' AS scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      count(*) FILTER (WHERE unifi_site_id IS NOT NULL) AS unifi_locs,
      count(*)                                          AS locs,
      string_agg(DISTINCT wifi_voucher_mode, ', ')      AS modes
    FROM locations
    WHERE is_active
  ) g
  CROSS JOIN LATERAL (VALUES
    ('active locations configured for UniFi', g.unifi_locs::bigint, g.locs::bigint, 'voucher modes in use: ' || COALESCE(g.modes,'none set'))
  ) v(chk, n, of_total, note)
),
b_wifi_v AS (
  SELECT 7 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE COALESCE(l.name, '(no location)') END AS scope,
      count(*)                                                                         AS total,
      count(*) FILTER (WHERE vi.seat_number IS NOT NULL)                               AS with_seat,
      count(*) FILTER (WHERE vi.contract_member_id IS NOT NULL)                        AS with_member,
      count(*) FILTER (WHERE vi.revoked_at IS NULL AND vi.valid_until > now())         AS live,
      count(*) FILTER (WHERE vi.revoked_at IS NULL AND vi.valid_until > now()
                         AND vi.contract_member_id IS NULL)                            AS live_no_member
    FROM voucher_issuances vi
    LEFT JOIN contracts c ON c.id = vi.contract_id
    LEFT JOIN locations l ON l.id = c.location_id
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('voucher issuances with a seat number',                       g.with_seat::bigint,      g.total::bigint, 'per-user Wi-Fi view groups by seat'),
    ('voucher issuances linked to a contract member (a name)',     g.with_member::bigint,    g.total::bigint, 'the share that shows a name without Assign name'),
    ('live vouchers with no member linked',                        g.live_no_member::bigint, g.live::bigint,  'rows that would show Unassigned today')
  ) v(chk, n, of_total, note)
),
-- 8. Electricity and rent ----------------------------------------------------
b_energy AS (
  SELECT 8 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE l.name END AS scope,
      count(*)                       AS readings,
      count(DISTINCT r.device_id)    AS devs,
      min(r.ts)::date                AS first_ts,
      max(r.ts)::date                AS last_ts
    FROM location_energy_readings r
    JOIN locations l ON l.id = r.location_id
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('energy ledger rows (15-minute buckets)', g.readings::bigint, g.readings::bigint, 'history ' || COALESCE(g.first_ts::text,'none') || ' to ' || COALESCE(g.last_ts::text,'none') || ', meters: ' || g.devs)
  ) v(chk, n, of_total, note)
),
b_energy_conn AS (
  SELECT 8 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE l.name END AS scope,
      count(*) FILTER (WHERE e.onegrid_device_id IS NOT NULL) AS with_dev,
      count(*)                                                AS total
    FROM location_electricity_connections e
    JOIN locations l ON l.id = e.location_id
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('electricity connections mapped to a OneGrid device', g.with_dev::bigint, g.total::bigint, 'unmapped meters have no readings')
  ) v(chk, n, of_total, note)
),
b_lease AS (
  SELECT 8 AS ord, g.scope, v.chk, v.n, v.of_total, v.note
  FROM (
    SELECT
      CASE WHEN GROUPING(l.id) = 1 THEN 'ALL LOCATIONS' ELSE l.name END AS scope,
      count(*) AS leases,
      count(DISTINCT pl.location_id) AS locs
    FROM property_leases pl
    JOIN locations l ON l.id = pl.location_id
    GROUP BY GROUPING SETS ((l.id, l.name), ())
  ) g
  CROSS JOIN LATERAL (VALUES
    ('property lease records (for rent per seat)', g.leases::bigint, g.leases::bigint, '(info) a location with 0 has no rent to allocate')
  ) v(chk, n, of_total, note)
),
-- 9. Concessions (optional tables are guarded: a table missing in this database shows NULL instead of failing the whole query) --------------------------------------------------------------
b_conc AS (
  SELECT 9 AS ord, 'ALL LOCATIONS' AS scope, v.chk, v.n, v.of_total, v.note
  FROM (VALUES
    ('rent waivers recorded (not revoked)',
       (SELECT count(*) FROM contract_rent_waivers WHERE revoked_at IS NULL)::bigint,
       (SELECT count(*) FROM contract_rent_waivers)::bigint,
       'earliest waiver: ' || COALESCE((SELECT min(waived_at)::date::text FROM contract_rent_waivers), 'none')),
    ('billing moratoriums recorded',  (CASE WHEN to_regclass('public.contract_billing_moratoriums') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.contract_billing_moratoriums', false, true, '')))[1]::text::bigint END), (CASE WHEN to_regclass('public.contract_billing_moratoriums') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.contract_billing_moratoriums', false, true, '')))[1]::text::bigint END), '(info)'),
    ('refund requests recorded',      (CASE WHEN to_regclass('public.refund_requests') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.refund_requests', false, true, '')))[1]::text::bigint END),              (CASE WHEN to_regclass('public.refund_requests') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.refund_requests', false, true, '')))[1]::text::bigint END),              '(info)'),
    ('waiver requests recorded',      (CASE WHEN to_regclass('public.waiver_requests') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.waiver_requests', false, true, '')))[1]::text::bigint END),              (CASE WHEN to_regclass('public.waiver_requests') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.waiver_requests', false, true, '')))[1]::text::bigint END),              '(info)')
  ) v(chk, n, of_total, note)
),
-- 10. Communication and feedback ---------------------------------------------
b_comm AS (
  SELECT 10 AS ord, 'ALL LOCATIONS' AS scope, v.chk, v.n, v.of_total, v.note
  FROM (VALUES
    ('communications_log rows',
       (SELECT count(*) FROM communications_log)::bigint, (SELECT count(*) FROM communications_log)::bigint,
       'entity types: ' || COALESCE((SELECT string_agg(DISTINCT entity_type, ', ') FROM communications_log), 'none')
       || '; earliest ' || COALESCE((SELECT min(created_at)::date::text FROM communications_log), 'none')),
    ('WhatsApp messages (all)',
       (SELECT count(*) FROM whatsapp_messages)::bigint, (SELECT count(*) FROM whatsapp_messages)::bigint,
       'earliest ' || COALESCE((SELECT min(created_at)::date::text FROM whatsapp_messages), 'none')),
    ('WhatsApp messages that are inbound',
       (SELECT count(*) FROM whatsapp_messages WHERE direction ILIKE 'in%')::bigint, (SELECT count(*) FROM whatsapp_messages)::bigint,
       'low % = inbound customer messages are not captured'),
    ('receivable reminders sent',     (CASE WHEN to_regclass('public.receivable_reminder_sends') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.receivable_reminder_sends', false, true, '')))[1]::text::bigint END), (CASE WHEN to_regclass('public.receivable_reminder_sends') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.receivable_reminder_sends', false, true, '')))[1]::text::bigint END), '(info)'),
    ('billing queries raised',        (CASE WHEN to_regclass('public.billing_queries') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.billing_queries', false, true, '')))[1]::text::bigint END),           (CASE WHEN to_regclass('public.billing_queries') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.billing_queries', false, true, '')))[1]::text::bigint END),           '(info)'),
    ('booking feedback responses',    (CASE WHEN to_regclass('public.booking_feedbacks') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.booking_feedbacks', false, true, '')))[1]::text::bigint END),         (CASE WHEN to_regclass('public.booking_feedbacks') IS NOT NULL THEN (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.booking_feedbacks', false, true, '')))[1]::text::bigint END),         '(info)')
  ) v(chk, n, of_total, note)
)
SELECT
  CASE ord
    WHEN 1 THEN '1 Journey (contracts, renewals, escalation)'
    WHEN 2 THEN '2 Journey (leads)'
    WHEN 3 THEN '3 Payment timing'
    WHEN 4 THEN '4 Seats paid'
    WHEN 5 THEN '5 Seats used (door access)'
    WHEN 6 THEN '6 Tickets'
    WHEN 7 THEN '7 Wi-Fi'
    WHEN 8 THEN '8 Electricity and rent'
    WHEN 9 THEN '9 Concessions'
    WHEN 10 THEN '10 Communication and feedback'
  END                                               AS area,
  scope,
  chk,
  n,
  of_total,
  CASE WHEN of_total > 0 THEN round(100.0 * n / of_total, 1) END AS pct,
  note
FROM (
  SELECT * FROM b_contracts
  UNION ALL SELECT * FROM b_leads
  UNION ALL SELECT * FROM b_pay
  UNION ALL SELECT * FROM b_seats
  UNION ALL SELECT * FROM b_door
  UNION ALL SELECT * FROM b_door_active
  UNION ALL SELECT * FROM b_door_dev
  UNION ALL SELECT * FROM b_tix
  UNION ALL SELECT * FROM b_wifi_loc
  UNION ALL SELECT * FROM b_wifi_v
  UNION ALL SELECT * FROM b_energy
  UNION ALL SELECT * FROM b_energy_conn
  UNION ALL SELECT * FROM b_lease
  UNION ALL SELECT * FROM b_conc
  UNION ALL SELECT * FROM b_comm
) r
ORDER BY ord, (scope <> 'ALL LOCATIONS'), scope, chk;
