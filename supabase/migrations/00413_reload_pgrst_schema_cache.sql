-- Force PostgREST to reload its schema cache so the new
-- proposals.deposit_payment_recorded_by FK relationship is queryable immediately.
NOTIFY pgrst, 'reload schema';
