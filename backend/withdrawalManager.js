const crypto = require("node:crypto");
const { pool } = require("./database");
const { normalizePhone, hashToken } = require("./payhero");
const PayHeroPayout = require("./payheroPayout");
const OneAppPayout = require("./oneAppPayout");
function defaultProvider() {
    const name = process.env.WITHDRAWAL_PROVIDER || "payhero";
    if (name === "oneapp") return new OneAppPayout();
    if (name === "payhero") return new PayHeroPayout();
    throw new Error("WITHDRAWAL_PROVIDER must be payhero or oneapp");
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class WithdrawalManager {
    constructor(provider = defaultProvider(), database = pool) { this.provider = provider; this.db = database; }
    publicWithdrawal(row) {
        return { id: row.id, amount: Number(row.amount), currency: "KES", status: row.status,
            phone: `${row.phone.slice(0, 3)}*****${row.phone.slice(-4)}`, receipt: row.receipt, createdAt: row.created_at };
    }
    async summary(userId) {
        const [wallet, history] = await Promise.all([
            this.db.query("SELECT held_balance FROM cash_wallets WHERE user_id = $1", [userId]),
            this.db.query("SELECT * FROM wallet_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [userId])
        ]);
        return { heldBalance: Number(wallet.rows[0]?.held_balance || 0), withdrawalsEnabled: this.provider.enabled,
            withdrawalsSimulated: this.provider.simulated === true,
            withdrawals: history.rows.map(row => this.publicWithdrawal(row)) };
    }
    async initiate(userId, { amount, phone, requestKey } = {}) {
        if (!Number.isInteger(amount) || amount < 1 || amount > 150000) throw new Error("Withdrawal amount must be a whole number from KES 1 to 150,000");
        phone = normalizePhone(phone);
        if (!UUID.test(requestKey || "")) throw new Error("Invalid withdrawal request key");
        if (!this.provider.enabled) throw new Error("M-Pesa withdrawals are not configured yet");
        const client = await this.db.connect();
        const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString("hex");
        let withdrawal;
        try {
            await client.query("BEGIN");
            await client.query("INSERT INTO cash_wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
            const wallet = await client.query("SELECT balance FROM cash_wallets WHERE user_id = $1 FOR UPDATE", [userId]);
            const existing = await client.query("SELECT * FROM wallet_withdrawals WHERE user_id = $1 AND request_key = $2", [userId, requestKey]);
            if (existing.rows.length) {
                if (Number(existing.rows[0].amount) !== amount || existing.rows[0].phone !== phone) throw new Error("Withdrawal request key was already used for different details");
                await client.query("COMMIT"); return this.publicWithdrawal(existing.rows[0]);
            }
            const pending = await client.query(`SELECT id FROM wallet_withdrawals WHERE user_id = $1
                AND (status IN ('created','pending','unknown','review') OR created_at > NOW() - INTERVAL '60 seconds') LIMIT 1`, [userId]);
            if (pending.rows.length) throw new Error("Please wait for your previous withdrawal to finish before making another request");
            if (Number(wallet.rows[0].balance) < amount) throw new Error("Insufficient cash balance");
            const result = await client.query(`INSERT INTO wallet_withdrawals
                (id, user_id, request_key, amount, phone, callback_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
                [id, userId, requestKey, amount, phone, hashToken(token)]);
            withdrawal = result.rows[0];
            const updated = await client.query(`UPDATE cash_wallets SET balance = balance - $2,
                held_balance = held_balance + $2, updated_at = NOW() WHERE user_id = $1 RETURNING balance`, [userId, amount]);
            await client.query(`INSERT INTO cash_withdrawal_ledger (user_id, withdrawal_id, type, amount, balance_before, balance_after)
                VALUES ($1,$2,'reserve',$3,$4,$5)`, [userId, id, amount, wallet.rows[0].balance, updated.rows[0].balance]);
            await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }

        try {
            const accepted = await this.provider.initiate(withdrawal, token);
            const result = await this.db.query(`UPDATE wallet_withdrawals SET provider_reference = $2,
                callback_event = COALESCE($3::jsonb, callback_event),
                status = CASE WHEN status = 'created' THEN 'pending' ELSE status END, updated_at = NOW()
                WHERE id = $1 RETURNING *`, [id, accepted.reference, accepted.event ? JSON.stringify(accepted.event) : null]);
            if (accepted.event || result.rows[0].callback_event) {
                await this.callback(id, token, accepted.event || result.rows[0].callback_event);
                const latest = await this.db.query("SELECT * FROM wallet_withdrawals WHERE id = $1", [id]);
                return this.publicWithdrawal(latest.rows[0]);
            }
            return this.publicWithdrawal(result.rows[0]);
        } catch {
            // A timeout may follow a real payout. Keep the hold; never retry or refund automatically.
            const result = await this.db.query(`UPDATE wallet_withdrawals SET status = 'unknown', updated_at = NOW()
                WHERE id = $1 AND status IN ('created','pending') RETURNING *`, [id]);
            return this.publicWithdrawal(result.rows[0] || withdrawal);
        }
    }
    async callback(id, token, event, stored = false) {
        if (!UUID.test(id || "") || (!stored && !/^[a-f0-9]{64}$/.test(token || ""))) return false;
        const client = await this.db.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query("SELECT * FROM wallet_withdrawals WHERE id = $1 FOR UPDATE", [id]);
            const w = result.rows[0];
            if (!w || (!stored && !crypto.timingSafeEqual(Buffer.from(w.callback_hash), Buffer.from(hashToken(token))))) {
                await client.query("ROLLBACK"); return false;
            }
            if (["successful", "failed"].includes(w.status)) { await client.query("COMMIT"); return true; }
            if (!event || event.external_reference !== id || event.transaction_type !== "outbound_payment") throw new Error("Invalid withdrawal confirmation");
            await client.query("UPDATE wallet_withdrawals SET callback_event = $2 WHERE id = $1", [id, JSON.stringify(event)]);
            if (!w.provider_reference) { await client.query("COMMIT"); return true; }
            const valid = event.reference === w.provider_reference && Number(event.amount) === Number(w.amount) &&
                event.currency === "KES" && ((event.status === "success" && event.success === true && Boolean(event.provider_reference)) ||
                (event.status === "failed" && event.success === false));
            if (!valid) {
                await client.query("UPDATE wallet_withdrawals SET status = 'review', updated_at = NOW() WHERE id = $1", [id]);
                await client.query("COMMIT"); return true;
            }
            const success = event.status === "success";
            const wallet = await client.query("SELECT balance FROM cash_wallets WHERE user_id = $1 FOR UPDATE", [w.user_id]);
            const updated = await client.query(`UPDATE cash_wallets SET held_balance = held_balance - $2,
                balance = balance + $3, updated_at = NOW() WHERE user_id = $1 RETURNING balance`,
                [w.user_id, w.amount, success ? 0 : w.amount]);
            await client.query(`INSERT INTO cash_withdrawal_ledger (user_id, withdrawal_id, type, amount, balance_before, balance_after)
                VALUES ($1,$2,$3,$4,$5,$6)`, [w.user_id, id, success ? "paid" : "refund", w.amount,
                wallet.rows[0].balance, updated.rows[0].balance]);
            await client.query(`UPDATE wallet_withdrawals SET status = $2, receipt = $3, updated_at = NOW() WHERE id = $1`,
                [id, success ? "successful" : "failed", success ? String(event.provider_reference) : null]);
            await client.query("COMMIT"); return true;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
    }
    async processStoredEvents() {
        const result = await this.db.query(`SELECT id, callback_event FROM wallet_withdrawals
            WHERE provider_reference IS NOT NULL AND callback_event IS NOT NULL AND status IN ('created','pending','unknown') LIMIT 25`);
        for (const row of result.rows) {
            try { await this.callback(row.id, null, row.callback_event, true); }
            catch (error) { console.error("Withdrawal confirmation:", error.message); }
        }
    }
}
module.exports = WithdrawalManager;
