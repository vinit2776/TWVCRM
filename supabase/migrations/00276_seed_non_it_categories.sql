-- Seed facility asset categories for non-IT scopes.
-- HVAC already has 'hvac-ac' from 00270; add remaining categories.

INSERT INTO facility_asset_categories
  (scope, name, slug, icon, description,
   default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs,
   sort_order)
VALUES
  -- HVAC (supplement existing AC)
  ('hvac', 'Exhaust Fan', 'hvac-exhaust', 'Fan', 'Exhaust and ventilation fans',
   4, 12, 48, 96, 20),
  ('hvac', 'Water Heater / Geyser', 'hvac-geyser', 'Flame', 'Geysers and water heating systems',
   4, 12, 48, 96, 30),

  -- Plumbing
  ('plumbing', 'Water Supply / Tap', 'plumb-tap', 'Droplets', 'Taps, faucets, water supply lines',
   2, 8, 24, 72, 10),
  ('plumbing', 'Drainage / Sewage', 'plumb-drain', 'Droplets', 'Drains, sewage pipes, floor traps',
   2, 6, 24, 72, 20),
  ('plumbing', 'Toilet / Washroom', 'plumb-toilet', 'Droplets', 'WC, urinals, washbasins, cisterns',
   2, 6, 24, 72, 30),
  ('plumbing', 'Water Tank / Pump', 'plumb-pump', 'Droplets', 'Overhead/underground tanks, pumps, motors',
   2, 8, 24, 72, 40),

  -- Electrical
  ('electrical', 'Lighting', 'elec-lights', 'Lightbulb', 'Tube lights, bulbs, panel lights, emergency lights',
   4, 12, 48, 96, 10),
  ('electrical', 'Power Socket / Extension', 'elec-socket', 'Plug', 'Power sockets, extension boards, adapters',
   2, 8, 24, 72, 20),
  ('electrical', 'MCB / Distribution Panel', 'elec-panel', 'Zap', 'MCBs, distribution boards, circuit breakers',
   1, 4, 12, 48, 30),
  ('electrical', 'UPS / Inverter', 'elec-ups', 'BatteryCharging', 'UPS systems, inverters, batteries',
   2, 8, 24, 72, 40),
  ('electrical', 'Generator / DG Set', 'elec-dg', 'Zap', 'Diesel generators, AMF panels',
   1, 4, 12, 48, 50),
  ('electrical', 'Earthing / Wiring', 'elec-wiring', 'Zap', 'Electrical wiring, earthing, conduits',
   2, 8, 24, 72, 60),

  -- Housekeeping
  ('housekeeping', 'Furniture', 'hk-furniture', 'Armchair', 'Desks, chairs, sofas, cabinets, shelving',
   8, 24, 72, 168, 10),
  ('housekeeping', 'Glass / Window', 'hk-glass', 'Sparkles', 'Glass partitions, windows, blinds',
   4, 24, 72, 168, 20),
  ('housekeeping', 'Flooring / Carpet', 'hk-floor', 'Sparkles', 'Tiles, carpet, vinyl, floor damage',
   8, 24, 72, 168, 30),
  ('housekeeping', 'Door / Lock', 'hk-door', 'DoorOpen', 'Doors, hinges, locks, access hardware',
   2, 8, 24, 72, 40),
  ('housekeeping', 'Signage / Branding', 'hk-signage', 'Sparkles', 'Name plates, way-finding signs, branding panels',
   24, 48, 96, 168, 50),
  ('housekeeping', 'Pest Control', 'hk-pest', 'Bug', 'Pest-related issues — rodents, termites, insects',
   4, 12, 48, 96, 60),

  -- Security
  ('security', 'CCTV Camera', 'sec-cctv', 'Camera', 'IP cameras, DVR/NVR, monitoring equipment',
   2, 8, 24, 72, 10),
  ('security', 'Access Control / Biometric', 'sec-access', 'Fingerprint', 'Biometric readers, card readers, turnstiles',
   2, 6, 24, 72, 20),
  ('security', 'Fire Alarm / Extinguisher', 'sec-fire', 'Flame', 'Fire alarm panels, smoke detectors, extinguishers, sprinklers',
   1, 4, 12, 48, 30),
  ('security', 'Intercom / PA System', 'sec-intercom', 'Phone', 'Intercom units, PA system, emergency call points',
   4, 12, 48, 96, 40),

  -- Other / General
  ('other', 'General / Miscellaneous', 'other-general', 'HelpCircle', 'Anything not covered by a specific category',
   4, 12, 48, 96, 10),
  ('other', 'Elevator / Lift', 'other-elevator', 'ArrowUpDown', 'Passenger and service elevators',
   1, 4, 12, 48, 20),
  ('other', 'Parking', 'other-parking', 'Car', 'Parking barriers, boom gates, markings',
   8, 24, 72, 168, 30)

ON CONFLICT (slug) DO NOTHING;
