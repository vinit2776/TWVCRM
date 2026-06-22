-- AMC coverage type: comprehensive (parts + labour) vs labour_only (service only)
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS amc_coverage_type TEXT
    CHECK (amc_coverage_type IN ('comprehensive', 'labour_only'));
