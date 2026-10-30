
const { pool } = require("./database");

class BetManager {
    constructor(gameEngine) {
        this.game = gameEngine;
        this.maxBetsPerUserPerRound = 2;
    }

    validateAmount(amount) {
        if (
            typeof amount !== "number" ||
            !Number.isFinite(amount) ||
            amount <= 0 ||
            amount > 999999999999.99
        ) {
            throw new Error("Invalid bet amount");
        }

        const cents = Math.round(amount * 100);

        if (
            !Number.isSafeInteger(cents) ||
            Math.abs(amount * 100 - cents) > 0.000001
        ) {
            throw new Error(
                "Bet amount must have at most two decimal places"
            );
        }

        return cents;
    }

    formatBet(row) {
        if (!row) return null;

        return {
            id: String(row.id),
            userId: String(row.user_id),
            roundNumber: Number(row.round_number),
            slot: Number(row.slot),
            amount: Number(row.amount),
            autoCashout: row.auto_cashout == null ? null : Number(row.auto_cashout),
            cashOutMultiplier:
                row.cash_out_multiplier == null
                    ? null
                    : Number(row.cash_out_multiplier),
            payout: Number(row.payout || 0),
            profit: Number(row.profit || 0),
            status: row.status,
            placedAt: row.placed_at,
            cashedOutAt: row.cashed_out_at
        };
    }

    currentRound() {
        if (!this.game) {
            throw new Error("Game engine unavailable");
        }

        const round = this.game.getCurrentRound();

        if (!round) {
            throw new Error("No current round");
        }

        return round;
    }

    async placeBet({ userId, amount, slot, roundNumber: requestedRound, autoCashout = null }) {
        if (![1, 2].includes(slot)) throw new Error("Invalid bet slot");
        if (autoCashout !== null && (
            typeof autoCashout !== "number" || !Number.isFinite(autoCashout) ||
            autoCashout < 1.01 || autoCashout > 1000000 ||
            Math.abs(autoCashout * 100 - Math.round(autoCashout * 100)) > 0.000001
        )) throw new Error("Invalid auto cash-out target");
        const amountCents = this.validateAmount(amount);
        const round = this.currentRound();

        if (round.status !== "waiting" || round.roundNumber !== requestedRound) {
            throw new Error("Betting is closed");
        }

        const roundNumber = round.roundNumber;
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const roundResult = await client.query(
                `SELECT status
                 FROM game_rounds
                 WHERE round_number = $1
                 FOR UPDATE`,
                [roundNumber]
            );

            if (
                roundResult.rows[0]?.status !== "waiting" ||
                this.currentRound().roundNumber !== roundNumber ||
                this.currentRound().status !== "waiting"
            ) {
                throw new Error("Betting is closed");
            }

            const walletResult = await client.query(
                `SELECT balance
                 FROM wallets
                 WHERE user_id = $1
                 FOR UPDATE`,
                [userId]
            );

            if (!walletResult.rows.length) {
                throw new Error("Wallet not found");
            }

            const existing = await client.query(
                `SELECT *
                 FROM bets
                 WHERE user_id = $1
                   AND round_number = $2`,
                [userId, roundNumber]
            );

            const previous = existing.rows.find(row => Number(row.slot) === slot);
            if (previous) {
                await client.query("COMMIT");
                return this.formatBet(previous);
            }

            if (
                existing.rows.length >=
                this.maxBetsPerUserPerRound
            ) {
                throw new Error("Maximum two bets per round");
            }

            const before = Math.round(
                Number(walletResult.rows[0].balance) * 100
            );

            if (before < amountCents) {
                throw new Error("Insufficient balance");
            }

            const after = before - amountCents;

            const betResult = await client.query(
                `INSERT INTO bets (
                    user_id,
                    round_number,
                    slot,
                    amount,
                    auto_cashout,
                    status
                )
                VALUES ($1, $2, $3, $4, $5, 'active')
                RETURNING *`,
                [
                    userId,
                    roundNumber,
                    slot,
                    (amountCents / 100).toFixed(2),
                    autoCashout
                ]
            );

            const bet = betResult.rows[0];

            await client.query(
                `UPDATE wallets
                 SET balance = $2,
                     updated_at = NOW()
                 WHERE user_id = $1`,
                [
                    userId,
                    (after / 100).toFixed(2)
                ]
            );

            await client.query(
                `INSERT INTO transactions (
                    user_id,
                    type,
                    amount,
                    balance_before,
                    balance_after,
                    reference,
                    metadata
                )
                VALUES (
                    $1, 'bet_debit', $2, $3, $4, $5, $6
                )`,
                [
                    userId,
                    (amountCents / 100).toFixed(2),
                    (before / 100).toFixed(2),
                    (after / 100).toFixed(2),
                    `bet:${bet.id}:debit`,
                    JSON.stringify({
                        betId: String(bet.id),
                        roundNumber
                    })
                ]
            );

            await client.query("COMMIT");

            return this.formatBet(bet);
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async cashOut({ betId, userId }, automatic = false) {
        const round = this.currentRound();
        if (round.status !== "running") throw new Error("Cash-out is closed");
        const result = await pool.query(
            "SELECT settle_virtual_cashout($1, $2, $3, $4, $5) AS settlement",
            [betId, userId, round.roundNumber, round.crashPoint, automatic]
        );
        const settlement = result.rows[0].settlement;
        return { ...this.formatBet(settlement.bet), walletBalance: Number(settlement.balance) };
    }

    async settleAutoCashouts() {
        const round = this.currentRound();
        if (round.status !== "running") return;
        const result = await pool.query(
            `SELECT b.id, b.user_id FROM bets b
             JOIN game_rounds r ON r.round_number = b.round_number
             WHERE b.round_number = $1 AND b.status = 'active'
               AND b.auto_cashout < $2
               AND clock_timestamp() >= r.started_at +
                   (10 * ln(b.auto_cashout::double precision)) * INTERVAL '1 second'`,
            [round.roundNumber, round.crashPoint]
        );
        for (const bet of result.rows) {
            try {
                await this.cashOut({ betId: bet.id, userId: bet.user_id }, true);
            } catch (error) {
                if (error.message !== "Bet already settled") throw error;
            }
        }
    }

    async getBet(betId) {
        const result = await pool.query(
            `SELECT *
             FROM bets
             WHERE id = $1`,
            [betId]
        );

        return this.formatBet(result.rows[0]);
    }

    async getUserBets(userId, limit = 50) {
        const safeLimit = Math.min(
            100,
            Math.max(1, Math.trunc(Number(limit) || 50))
        );

        const result = await pool.query(
            `SELECT *
             FROM bets
             WHERE user_id = $1
             ORDER BY placed_at DESC, id DESC
             LIMIT $2`,
            [userId, safeLimit]
        );

        return result.rows.map(row =>
            this.formatBet(row)
        );
    }
}

module.exports = BetManager;
