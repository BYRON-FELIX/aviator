-- One database call settles the bet, wallet and ledger in a single transaction.
CREATE OR REPLACE FUNCTION settle_virtual_cashout(
    p_bet_id BIGINT, p_user_id BIGINT, p_round_number INTEGER,
    p_crash_point NUMERIC, p_automatic BOOLEAN
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    r game_rounds%ROWTYPE;
    b bets%ROWTYPE;
    balance_before NUMERIC;
    balance_after NUMERIC;
    checked_at TIMESTAMPTZ;
    deadline TIMESTAMPTZ;
    elapsed_ms DOUBLE PRECISION;
    multiplier NUMERIC;
    v_payout NUMERIC;
BEGIN
    -- Cash-outs can share this lock; starting/crashing the round requires an exclusive lock.
    SELECT * INTO r FROM game_rounds WHERE round_number = p_round_number FOR SHARE;
    IF NOT FOUND OR r.status <> 'running' OR r.started_at IS NULL THEN
        RAISE EXCEPTION 'Round is no longer running';
    END IF;
    IF p_crash_point IS NULL OR p_crash_point <= 1 THEN
        RAISE EXCEPTION 'Cash-out unavailable';
    END IF;
    SELECT balance INTO balance_before FROM wallets WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;
    SELECT * INTO b FROM bets
        WHERE id = p_bet_id AND user_id = p_user_id AND round_number = p_round_number FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bet not found'; END IF;
    IF b.status <> 'active' THEN RAISE EXCEPTION 'Bet already settled'; END IF;

    checked_at := clock_timestamp();
    deadline := r.started_at + (10 * ln(p_crash_point::double precision)) * INTERVAL '1 second';
    elapsed_ms := GREATEST(0, EXTRACT(EPOCH FROM (checked_at - r.started_at)) * 1000);
    IF NOT p_automatic AND checked_at >= deadline THEN
        RAISE EXCEPTION 'Aircraft already crashed';
    END IF;
    IF p_automatic THEN
        multiplier := b.auto_cashout;
        IF multiplier IS NULL OR multiplier < 1.01 OR
            elapsed_ms < 10000 * ln(multiplier::double precision) THEN
            RAISE EXCEPTION 'Auto cash-out target not reached';
        END IF;
    ELSE
        multiplier := GREATEST(1, floor(exp(elapsed_ms / 10000) * 100) / 100);
    END IF;
    IF multiplier >= p_crash_point THEN RAISE EXCEPTION 'Aircraft already crashed'; END IF;
    v_payout := floor(b.amount * multiplier * 100) / 100;
    balance_after := balance_before + v_payout;
    IF balance_after > 999999999999.99 OR v_payout > 999999999999.99 THEN
        RAISE EXCEPTION 'Wallet limit exceeded';
    END IF;

    UPDATE bets SET status = 'cashed_out', cash_out_multiplier = multiplier,
        payout = v_payout, profit = v_payout - amount,
        cashed_out_at = checked_at
        WHERE id = b.id AND status = 'active' AND (p_automatic OR clock_timestamp() < deadline)
        RETURNING * INTO b;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cash-out deadline passed'; END IF;
    UPDATE wallets SET balance = balance_after, updated_at = checked_at WHERE user_id = p_user_id;
    INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference, metadata)
        VALUES (p_user_id, 'bet_payout', v_payout, balance_before, balance_after,
            'bet:' || p_bet_id || ':payout', jsonb_build_object(
                'betId', p_bet_id::text, 'roundNumber', p_round_number, 'multiplier', multiplier));
    RETURN jsonb_build_object('bet', to_jsonb(b), 'balance', balance_after);
END;
$$;
