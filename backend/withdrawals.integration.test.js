require("dotenv").config();
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { query, closeDatabase } = require("./database");
const WithdrawalManager = require("./withdrawalManager");

test("withdrawal reservations, payouts, refunds and unknown outcomes", async () => {
    let userId, calls = 0, behavior = "normal";
    const tokens = new Map();
    function event(w, success = true) {
        return { external_reference: w.id, reference: `provider-${w.id}`, amount: w.amount, currency: "KES",
            transaction_type: "outbound_payment", success, status: success ? "success" : "failed",
            provider_reference: success ? `receipt-${w.id}` : "" };
    }
    const provider = { enabled: true, initiate: async (w, token) => {
        calls++; tokens.set(w.id, token);
        if (behavior === "timeout") throw new Error("Ambiguous timeout");
        if (behavior === "early") await withdrawals.callback(w.id, token, event(w));
        if (behavior === "instant") return { reference: `provider-${w.id}`, event: event(w) };
        return { reference: `provider-${w.id}` };
    } };
    const withdrawals = new WithdrawalManager(provider);
    async function balances(available, held) {
        const result = await query("SELECT balance, held_balance FROM cash_wallets WHERE user_id = $1", [userId]);
        assert.equal(Number(result.rows[0].balance), available);
        assert.equal(Number(result.rows[0].held_balance), held);
    }
    const request = amount => ({ amount, phone: "0712345678", requestKey: crypto.randomUUID() });
    const age = () => query("UPDATE wallet_withdrawals SET created_at = NOW() - INTERVAL '2 minutes' WHERE user_id = $1", [userId]);
    try {
        const user = await query(`INSERT INTO users (username, password_hash, password_salt)
            VALUES ($1, 'test-only', 'test-only') RETURNING id`, [`wd_test_${crypto.randomBytes(8).toString("hex")}`]);
        userId = String(user.rows[0].id);
        await query("INSERT INTO cash_wallets (user_id, balance) VALUES ($1, 1000)", [userId]);
        await assert.rejects(withdrawals.initiate(userId, request(1001)), /Insufficient cash/);
        const r = request(600);
        const [first, duplicate] = await Promise.all([withdrawals.initiate(userId, r), withdrawals.initiate(userId, r)]);
        assert.equal(first.id, duplicate.id);
        assert.equal(calls, 1);
        await balances(400, 600);
        await assert.rejects(withdrawals.initiate(userId, request(500)), /previous withdrawal/);
        assert.equal(await withdrawals.callback(first.id, "0".repeat(64), event(first)), false);
        await balances(400, 600);
        await withdrawals.callback(first.id, tokens.get(first.id), { ...event(first), amount: 601 });
        await balances(400, 600);
        await Promise.all([withdrawals.callback(first.id, tokens.get(first.id), event(first)), withdrawals.callback(first.id, tokens.get(first.id), event(first))]);
        await balances(400, 0);
        const paid = await query("SELECT count(*) FROM cash_withdrawal_ledger WHERE withdrawal_id = $1 AND type = 'paid'", [first.id]);
        assert.equal(Number(paid.rows[0].count), 1);

        await age();
        const failed = await withdrawals.initiate(userId, request(200));
        await balances(200, 200);
        await Promise.all([withdrawals.callback(failed.id, tokens.get(failed.id), event(failed, false)), withdrawals.callback(failed.id, tokens.get(failed.id), event(failed, false))]);
        await balances(400, 0);
        const refunded = await query("SELECT count(*) FROM cash_withdrawal_ledger WHERE withdrawal_id = $1 AND type = 'refund'", [failed.id]);
        assert.equal(Number(refunded.rows[0].count), 1);

        await age(); behavior = "early";
        const early = await withdrawals.initiate(userId, request(50));
        assert.equal(early.status, "successful");
        await balances(350, 0);

        await age(); behavior = "instant";
        const instantRequest = request(50);
        const instant = await withdrawals.initiate(userId, instantRequest);
        assert.equal(instant.status, "successful");
        await balances(300, 0);
        const beforeDuplicate = calls;
        assert.equal((await withdrawals.initiate(userId, instantRequest)).id, instant.id);
        assert.equal(calls, beforeDuplicate);

        await age(); behavior = "timeout";
        const ambiguous = request(100);
        const unknown = await withdrawals.initiate(userId, ambiguous);
        assert.equal(unknown.status, "unknown");
        await balances(200, 100);
        const beforeRetry = calls;
        assert.equal((await withdrawals.initiate(userId, ambiguous)).id, unknown.id);
        assert.equal(calls, beforeRetry);
        await assert.rejects(withdrawals.initiate(userId, request(100)), /previous withdrawal/);
    } finally {
        if (userId) {
            await query("DELETE FROM cash_withdrawal_ledger WHERE user_id = $1", [userId]);
            await query("DELETE FROM wallet_withdrawals WHERE user_id = $1", [userId]);
            await query("DELETE FROM cash_wallets WHERE user_id = $1", [userId]);
            await query("DELETE FROM users WHERE id = $1", [userId]);
        }
        await closeDatabase();
    }
});
