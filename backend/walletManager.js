
const { pool } = require("./database");

class WalletManager {
    constructor() {
        this.maxAmount = 999999999999.99;
    }

    // Convert money to integer cents for calculations.
    toCents(amount) {
        if (
            typeof amount !== "number" ||
            !Number.isFinite(amount) ||
            amount <= 0 ||
            amount > this.maxAmount
        ) {
            throw new Error("Invalid transaction amount");
        }

        const cents = Math.round(amount * 100);

        if (
            !Number.isSafeInteger(cents) ||
            Math.abs(amount * 100 - cents) > 0.000001
        ) {
            throw new Error(
                "Amount must have no more than two decimal places"
            );
        }

        return cents;
    }

    fromCents(cents) {
        return cents / 100;
    }

    async createWallet(userId, initialBalance = 0) {
        if (initialBalance !== 0) {
            throw new Error(
                "Wallets must start at zero. Use a recorded deposit for funding."
            );
        }

        const result = await pool.query(
            `INSERT INTO wallets (user_id, balance)
             VALUES ($1, 0)
             ON CONFLICT (user_id) DO NOTHING
             RETURNING user_id, balance, updated_at`,
            [userId]
        );

        if (result.rows.length > 0) {
            return this.formatWallet(result.rows[0]);
        }

        return this.getWallet(userId);
    }

    async getWallet(userId) {
        const result = await pool.query(
            `SELECT user_id, balance, updated_at
             FROM wallets
             WHERE user_id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        return this.formatWallet(result.rows[0]);
    }

    async getBalance(userId) {
        const wallet = await this.getWallet(userId);

        if (!wallet) {
            throw new Error("Wallet not found");
        }

        return wallet.balance;
    }

    async deposit(userId, amount, options = {}) {
        return this.changeBalance(
            userId,
            amount,
            "credit",
            options.type || "deposit",
            options
        );
    }

    async withdraw(userId, amount, options = {}) {
        return this.changeBalance(
            userId,
            amount,
            "debit",
            options.type || "withdrawal",
            options
        );
    }

    async debit(userId, amount, options = {}) {
        return this.changeBalance(
            userId,
            amount,
            "debit",
            options.type || "bet_debit",
            options
        );
    }

    async credit(userId, amount, options = {}) {
        return this.changeBalance(
            userId,
            amount,
            "credit",
            options.type || "bet_payout",
            options
        );
    }

    async changeBalance(
        userId,
        amount,
        direction,
        type,
        options = {}
    ) {
        const amountCents = this.toCents(amount);

        const allowedTypes = [
            "deposit",
            "withdrawal",
            "bet_debit",
            "bet_payout",
            "refund",
            "adjustment"
        ];

        if (!allowedTypes.includes(type)) {
            throw new Error("Invalid transaction type");
        }

        if (
            (direction === "credit" &&
                ["withdrawal", "bet_debit"].includes(type)) ||
            (direction === "debit" &&
                ["deposit", "bet_payout", "refund"].includes(type))
        ) {
            throw new Error(
                "Transaction type does not match balance direction"
            );
        }

        if (
            options.reference !== undefined &&
            (
                typeof options.reference !== "string" ||
                options.reference.length > 150 ||
                options.reference.length === 0
            )
        ) {
            throw new Error("Invalid transaction reference");
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const walletResult = await client.query(
                `SELECT user_id, balance
                 FROM wallets
                 WHERE user_id = $1
                 FOR UPDATE`,
                [userId]
            );

            if (walletResult.rows.length === 0) {
                throw new Error("Wallet not found");
            }

            const currentBalanceCents = Math.round(
                Number(walletResult.rows[0].balance) * 100
            );

            const newBalanceCents =
                direction === "credit"
                    ? currentBalanceCents + amountCents
                    : currentBalanceCents - amountCents;

            if (newBalanceCents < 0) {
                throw new Error("Insufficient wallet balance");
            }

            if (
                !Number.isSafeInteger(newBalanceCents) ||
                newBalanceCents > Math.round(this.maxAmount * 100)
            ) {
                throw new Error("Wallet balance limit exceeded");
            }

            const before = this.fromCents(
                currentBalanceCents
            );

            const after = this.fromCents(
                newBalanceCents
            );

            const walletUpdate = await client.query(
                `UPDATE wallets
                 SET balance = $2,
                     updated_at = NOW()
                 WHERE user_id = $1
                 RETURNING user_id, balance, updated_at`,
                [userId, after.toFixed(2)]
            );

            const transactionResult = await client.query(
                `INSERT INTO transactions (
                    user_id,
                    type,
                    amount,
                    balance_before,
                    balance_after,
                    reference,
                    metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *`,
                [
                    userId,
                    type,
                    this.fromCents(amountCents).toFixed(2),
                    before.toFixed(2),
                    after.toFixed(2),
                    options.reference || null,
                    JSON.stringify(options.metadata || {})
                ]
            );

            await client.query("COMMIT");

            return {
                wallet: this.formatWallet(
                    walletUpdate.rows[0]
                ),
                transaction: this.formatTransaction(
                    transactionResult.rows[0]
                )
            };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async hasSufficientBalance(userId, amount) {
        const amountCents = this.toCents(amount);
        const wallet = await this.getWallet(userId);

        if (!wallet) {
            return false;
        }

        return (
            Math.round(wallet.balance * 100) >= amountCents
        );
    }

    async getTransactions(userId, limit = 50) {
        const safeLimit = Math.min(
            100,
            Math.max(1, Math.trunc(Number(limit) || 50))
        );

        const result = await pool.query(
            `SELECT *
             FROM transactions
             WHERE user_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2`,
            [userId, safeLimit]
        );

        return result.rows.map(row =>
            this.formatTransaction(row)
        );
    }

    formatWallet(row) {
        return {
            userId: String(row.user_id),
            balance: Number(row.balance),
            updatedAt: row.updated_at
        };
    }

    formatTransaction(row) {
        return {
            id: String(row.id),
            userId: String(row.user_id),
            type: row.type,
            amount: Number(row.amount),
            balanceBefore: Number(row.balance_before),
            balanceAfter: Number(row.balance_after),
            reference: row.reference,
            metadata: row.metadata,
            createdAt: row.created_at
        };
    }
}

module.exports = WalletManager;
