-- One more thing a person can log on an enquiry: "Replied on WhatsApp". Replies are written in the
-- WhatsApp app, which the CRM cannot see, so a one-tap button records it and clears the enquiry
-- from the Replies tab until the customer writes again.
-- Rollback: delete any 'replied_whatsapp' rows, then re-add the original constraint without the new kind.

ALTER TABLE enquiry_updates DROP CONSTRAINT IF EXISTS enquiry_updates_kind_check;
ALTER TABLE enquiry_updates ADD CONSTRAINT enquiry_updates_kind_check CHECK (kind IN (
  'call_no_answer', 'spoke_interested', 'visit_booked', 'visit_done',
  'details_sent', 'waiting_customer', 'note', 'replied_whatsapp'));
