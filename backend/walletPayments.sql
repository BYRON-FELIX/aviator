CREATE TABLE IF NOT EXISTS cash_wallets (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS wallet_deposits (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    request_key UUID NOT NULL,
    amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 150000),
    currency CHAR(3) NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
    phone VARCHAR(12) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'pending', 'unknown', 'failed', 'successful', 'review')),
    callback_hash CHAR(64) NOT NULL,
    provider_reference TEXT UNIQUE,
    checkout_id TEXT UNIQUE,
    receipt TEXT UNIQUE,
    callback_event JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, request_key)
);
ALTER TABLE wallet_deposits ADD COLUMN IF NOT EXISTS callback_event JSONB;
CREATE INDEX IF NOT EXISTS wallet_deposits_user_created ON wallet_deposits(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS cash_wallet_ledger (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    deposit_id UUID NOT NULL UNIQUE REFERENCES wallet_deposits(id) ON DELETE RESTRICT,
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    balance_before NUMERIC(14,2) NOT NULL,
    balance_after NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
