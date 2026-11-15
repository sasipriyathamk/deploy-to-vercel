INSERT INTO wallets (address, label, enabled)
VALUES ('STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk', 'Seed sniper', true)
ON CONFLICT (address) DO NOTHING;
