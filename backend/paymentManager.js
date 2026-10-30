const crypto = require("node:crypto");
const { PayHero, normalizePhone, hashToken } = require("./payhero");
const { pool } = require("./database");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class PaymentManager {
    constructor(provider = new PayHero(), database = pool) {
        this.provider = provider;
        this.db = database;
    }
    publicDeposit(row) {
        return {
            id: row.id, amount: Number(row.amount), currency: "KES", status: row.status,
            phone: `${row.phone.slice(0, 3)}*****${row.phone.slice(-4)}`,
            receipt: row.receipt, createdAt: row.created_at
        };
    }
    async summary(userId) {
        const [wallet, history] = await Promise.all([
            this.db.query("SELECT balance FROM cash_wallets WHERE user_id = $1", [userId]),
            this.db.query("SELECT * FROM wallet_deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [userId])
        ]);
        return { balance: Number(wallet.rows[0]?.balance || 0), currency: "KES",
            depositsEnabled: this.provider.enabled, deposits: history.rows.map(row => this.publicDeposit(row)) };
    }
    async initiate(userId, { amount, phone, requestKey } = {}) {
        if (!Number.isInteger(amount) || amount < 1 || amount > 150000) {
            throw new Error("Deposit amount must be a whole number from KES 1 to 150,000");
        }
        phone = normalizePhone(phone);
        if (!UUID.test(requestKey || "")) throw new Error("Invalid deposit request key");
        if (!this.provider.enabled) throw new Error("M-Pesa deposits are not configured yet");
        const client = await this.db.connect();
        const id = crypto.randomUUID();
        const token = crypto.randomBytes(32).toString("hex");
        let deposit;
        try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [phone]);
            await client.query("INSERT INTO cash_wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
            await client.query("SELECT user_id FROM cash_wallets WHERE user_id = $1 FOR UPDATE", [userId]);
            const existing = await client.query("SELECT * FROM wallet_deposits WHERE user_id = $1 AND request_key = $2", [userId, requestKey]);
            if (existing.rows.length) {
                if (Number(existing.rows[0].amount) !== amount || existing.rows[0].phone !== phone) throw new Error("Deposit request key was already used for different details");
                await client.query("COMMIT");
                return this.publicDeposit(existing.rows[0]);
            }
            const recent = await client.query(`SELECT id FROM wallet_deposits
                WHERE (user_id = $1 OR phone = $2) AND created_at > NOW() - INTERVAL '60 seconds' LIMIT 1`, [userId, phone]);
            if (recent.rows.length) throw new Error("Please wait one minute before requesting another M-Pesa prompt");
            const result = await client.query(`INSERT INTO wallet_deposits
                (id, user_id, request_key, amount, phone, callback_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
                [id, userId, requestKey, amount, phone, hashToken(token)]);
            deposit = result.rows[0];
            await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }

        try {
            const result = await this.provider.initiate(deposit, token);
            const updated = await this.db.query(`UPDATE wallet_deposits SET
                provider_reference = $2, checkout_id = $3,
                status = CASE WHEN status = 'created' THEN 'pending' ELSE status END,
                updated_at = NOW() WHERE id = $1 RETURNING *`, [id, result.reference, result.checkoutId]);
            if (updated.rows[0].callback_event) {
                await this.callback(id, token, updated.rows[0].callback_event);
                const latest = await this.db.query("SELECT * FROM wallet_deposits WHERE id = $1", [id]);
                return this.publicDeposit(latest.rows[0]);
            }
            return this.publicDeposit(updated.rows[0]);
        } catch {
            // Never repeat an STK automatically after an ambiguous timeout.
            const updated = await this.db.query(`UPDATE wallet_deposits SET status = 'unknown', updated_at = NOW()
                WHERE id = $1 AND status IN ('created','pending') RETURNING *`, [id]);
            return this.publicDeposit(updated.rows[0] || deposit);
        }
    }
    async callback(id, token, body, storedEvent = false) {
        if (!UUID.test(id || "") || (!storedEvent && !/^[a-f0-9]{64}$/.test(token || ""))) return false;
        const client = await this.db.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query("SELECT * FROM wallet_deposits WHERE id = $1 FOR UPDATE", [id]);
            const d = result.rows[0];
            if (!d || (!storedEvent && !crypto.timingSafeEqual(Buffer.from(d.callback_hash), Buffer.from(hashToken(token))))) {
                await client.query("ROLLBACK"); return false;
            }
            if (d.status === "successful") { await client.query("COMMIT"); return true; }
            const event = body?.response;
            if (!event || event.ExternalReference !== d.id) throw new Error("Invalid payment confirmation");
            if (!d.checkout_id) {
                await client.query("UPDATE wallet_deposits SET callback_event = $2 WHERE id = $1", [id, JSON.stringify(body)]);
                await client.query("COMMIT"); return true;
            }
            if (event.CheckoutRequestID !== d.checkout_id) throw new Error("Invalid payment confirmation");
            await client.query("UPDATE wallet_deposits SET callback_event = $2 WHERE id = $1", [id, JSON.stringify(body)]);
            if (event.ResultCode === undefined || event.ResultCode === null || event.ResultCode === "") throw new Error("Invalid payment confirmation");
            if (Number(event.ResultCode) !== 0) {
                await client.query("UPDATE wallet_deposits SET status = 'failed', updated_at = NOW() WHERE id = $1", [id]);
                await client.query("COMMIT"); return true;
            }
            if (String(event.Status).toLowerCase() !== "success" || Number(event.Amount) !== Number(d.amount) ||
                normalizePhone(String(event.Phone)) !== d.phone || !/^[A-Z0-9]{8,20}$/.test(event.MpesaReceiptNumber || "")) {
                await client.query("UPDATE wallet_deposits SET status = 'review', updated_at = NOW() WHERE id = $1", [id]);
                await client.query("COMMIT"); return true;
            }
            // All amounts are NUMERIC in PostgreSQL; the deposit lock and unique receipt/ledger
            // constraints ensure callback retries cannot credit a wallet twice.
            const wallet = await client.query("SELECT balance FROM cash_wallets WHERE user_id = $1 FOR UPDATE", [d.user_id]);
            const before = wallet.rows[0].balance;
            const credited = await client.query(`UPDATE cash_wallets SET balance = balance + $2, updated_at = NOW()
                WHERE user_id = $1 RETURNING balance`, [d.user_id, d.amount]);
            await client.query(`INSERT INTO cash_wallet_ledger (user_id, deposit_id, amount, balance_before, balance_after)
                VALUES ($1,$2,$3,$4,$5)`, [d.user_id, d.id, d.amount, before, credited.rows[0].balance]);
            await client.query(`UPDATE wallet_deposits SET status = 'successful', receipt = $2, updated_at = NOW() WHERE id = $1`, [id, event.MpesaReceiptNumber]);
            await client.query("COMMIT"); return true;
        } catch (error) {
            await client.query("ROLLBACK");
            if (error.code === "23505") {
                await client.query("UPDATE wallet_deposits SET status = 'review', updated_at = NOW() WHERE id = $1 AND status <> 'successful'", [id]);
                return true;
            }
            throw error;
        }
        finally { client.release(); }
    }
    async processStoredEvents() {
        const result = await this.db.query(`SELECT id, callback_event FROM wallet_deposits
            WHERE callback_event IS NOT NULL AND checkout_id IS NOT NULL
              AND status IN ('created','pending','unknown') LIMIT 25`);
        for (const row of result.rows) {
            try { await this.callback(row.id, null, row.callback_event, true); }
            catch (error) { console.error("Stored payment confirmation:", error.message); }
        }
    }
}
module.exports = PaymentManager;
