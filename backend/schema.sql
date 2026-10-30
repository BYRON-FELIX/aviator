
-- =========================================
-- AVIATOR GAME DATABASE SCHEMA
-- =========================================

-- 1. Users and authentication
CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. User wallets
CREATE TABLE IF NOT EXISTS wallets (
    user_id BIGINT PRIMARY KEY REFERENCES users(id)
        ON DELETE RESTRICT,
    balance NUMERIC(14, 2) NOT NULL DEFAULT 0.00
        CHECK (balance >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Game rounds and fairness records
CREATE TABLE IF NOT EXISTS game_rounds (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    round_number INTEGER NOT NULL UNIQUE
        CHECK (round_number > 0),
    server_seed_hash CHAR(64) NOT NULL,
    server_seed TEXT,
    crash_point NUMERIC(12, 2),
    status VARCHAR(20) NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'running', 'crashed')),
    started_at TIMESTAMPTZ,
    crashed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        crash_point IS NULL OR crash_point >= 1.00
    ),

    CHECK (
        server_seed IS NULL OR status = 'crashed'
    )
);

-- 4. Bets
CREATE TABLE IF NOT EXISTS bets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id)
        ON DELETE RESTRICT,
    round_number INTEGER NOT NULL REFERENCES game_rounds(round_number)
        ON DELETE RESTRICT,
    slot SMALLINT NOT NULL CHECK (slot IN (1, 2)),
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    cash_out_multiplier NUMERIC(12, 2),
    payout NUMERIC(14, 2) NOT NULL DEFAULT 0.00
        CHECK (payout >= 0),
    profit NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'cashed_out', 'lost')),
    placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cashed_out_at TIMESTAMPTZ,

    UNIQUE (user_id, round_number, slot),

    CHECK (
        cash_out_multiplier IS NULL
        OR cash_out_multiplier >= 1.00
    )
);

-- 5. Financial transaction ledger
CREATE TABLE IF NOT EXISTS transactions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id)
        ON DELETE RESTRICT,
    type VARCHAR(30) NOT NULL CHECK (
        type IN (
            'deposit',
            'withdrawal',
            'bet_debit',
            'bet_payout',
            'refund',
            'adjustment'
        )
    ),
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    balance_before NUMERIC(14, 2) NOT NULL
        CHECK (balance_before >= 0),
    balance_after NUMERIC(14, 2) NOT NULL
        CHECK (balance_after >= 0),
    reference VARCHAR(150) UNIQUE,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================
-- INDEXES FOR COMMON QUERIES
-- =========================================

CREATE INDEX IF NOT EXISTS idx_bets_user_round
    ON bets(user_id, round_number);

CREATE INDEX IF NOT EXISTS idx_bets_round_status
    ON bets(round_number, status);

CREATE INDEX IF NOT EXISTS idx_transactions_user_created
    ON transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rounds_created
    ON game_rounds(created_at DESC);
