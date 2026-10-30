ALTER TABLE cash_wallets ADD COLUMN IF NOT EXISTS held_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (held_balance >= 0);
CREATE TABLE IF NOT EXISTS wallet_withdrawals (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    request_key UUID NOT NULL,
    amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 150000),
    phone VARCHAR(12) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'created'
        CHECK (status IN ('created','pending','unknown','successful','failed','review')),
    callback_hash CHAR(64) NOT NULL,
    provider_reference TEXT UNIQUE,
    receipt TEXT UNIQUE,
    callback_event JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, request_key)
);
CREATE INDEX IF NOT EXISTS wallet_withdrawals_user_created ON wallet_withdrawals(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS cash_withdrawal_ledger (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    withdrawal_id UUID NOT NULL REFERENCES wallet_withdrawals(id) ON DELETE RESTRICT,
    type VARCHAR(20) NOT NULL CHECK (type IN ('reserve','paid','refund')),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    balance_before NUMERIC(14,2) NOT NULL,
    balance_after NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (withdrawal_id, type)
);
