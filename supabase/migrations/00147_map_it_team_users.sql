-- Map existing IT users to the it_team role
-- it_manager role for the main IT account
UPDATE users SET role = 'it_manager' WHERE email = 'it@theworkvilla.com';
-- it_technician role — account was created with a typo in the domain (theworkvill.com)
UPDATE users SET role = 'it_technician' WHERE email IN ('techsupport@theworkvilla.com', 'techsupport@theworkvill.com');
