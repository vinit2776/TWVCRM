-- Fix support ticket number generation race condition.
-- The old trigger used SELECT MAX(...) + 1 which causes duplicate key errors
-- under concurrent inserts. Replace with a proper PostgreSQL sequence.

-- 1. Create a sequence starting after the current max ticket number
DO $$
DECLARE
  max_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(ticket_number FROM 'TWV-T-(\d+)') AS INTEGER)
  ), 0) INTO max_num FROM public.support_tickets;

  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.support_ticket_number_seq START WITH %s', max_num + 1);
  -- If sequence already exists, advance it to current max
  IF max_num > 0 THEN
    PERFORM setval('public.support_ticket_number_seq', max_num, true);
  END IF;
END $$;

-- 2. Replace the trigger function to use the sequence
CREATE OR REPLACE FUNCTION public.generate_ticket_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.ticket_number := 'TWV-T-' || LPAD(nextval('public.support_ticket_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
