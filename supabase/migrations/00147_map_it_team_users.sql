-- Map existing IT users to the it_team role
UPDATE users SET role = 'it_team' WHERE email IN ('it@theworkvilla.com', 'techsupport@theworkvilla.com');
