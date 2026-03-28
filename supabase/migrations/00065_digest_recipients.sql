-- Daily digest email recipients (JSON array of email addresses)
INSERT INTO app_settings (key, value)
VALUES ('digest_recipients', '["vinit@theworkvilla.com"]')
ON CONFLICT (key) DO NOTHING;
