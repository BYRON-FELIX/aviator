require("dotenv").config();
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { query, closeDatabase } = require("./database");
const PaymentManager = require("./paymentManager");

test("KES deposits require authenticated matching confirmation and credit exactly once", async () => {
    let userId, callbackToken, calls = 0, earlyCallback = false;
    const provider = { enabled: true, initiate: async (deposit, token) => {
        calls++; callbackToken = token;
        if (earlyCallback) {
            await payments.callback(deposit.id, token, { response: {
                Amount: deposit.amount, Phone: deposit.phone, ExternalReference: deposit.id,
                CheckoutRequestID: `checkout-${deposit.id}`, ResultCode: 0, Status: "Success",
                MpesaReceiptNumber: `EAR${crypto.randomBytes(5).toString("hex").toUpperCase()}`
            } });
        }
        return { reference: `provider-${deposit.id}`, checkoutId: `checkout-${deposit.id}` };
    } };
    const payments = new PaymentManager(provider);
    try {
        const user = await query(`INSERT INTO users (username, password_hash, password_salt)
            VALUES ($1, 'test-only', 'test-only') RETURNING id`, [`pay_test_${crypto.randomBytes(8).toString("hex")}`]);
        userId = String(user.rows[0].id);
        await query("INSERT INTO wallets (user_id, balance) VALUES ($1,1000)", [userId]);
        const request = { amount: 100, phone: "0712345678", requestKey: crypto.randomUUID() };
        await assert.rejects(payments.initiate(userId, { ...request, amount: 1.1 }), /whole number/);
        const d = await payments.initiate(userId, request);
        assert.equal(d.status, "pending");
        assert.equal((await payments.summary(userId)).balance, 0);
        assert.equal((await payments.initiate(userId, request)).id, d.id);
        assert.equal(calls, 1);
        await assert.rejects(payments.initiate(userId, { ...request, amount: 200 }), /different details/);
        const event = { response: { Amount: 100, Phone: "+254712345678", ExternalReference: d.id,
            CheckoutRequestID: `checkout-${d.id}`, ResultCode: 0, Status: "Success", MpesaReceiptNumber: "TST12345678" } };
        assert.equal(await payments.callback(d.id, "a".repeat(64), event), false);
        assert.equal((await payments.summary(userId)).balance, 0);
        await assert.rejects(payments.callback(d.id, callbackToken, { response: { ...event.response, CheckoutRequestID: "wrong" } }), /Invalid payment/);
        await payments.callback(d.id, callbackToken, { response: { ...event.response, Amount: 200 } });
        assert.equal((await payments.summary(userId)).balance, 0);
        assert.equal((await payments.summary(userId)).deposits[0].status, "review");
        await Promise.all([payments.callback(d.id, callbackToken, event), payments.callback(d.id, callbackToken, event)]);
        const summary = await payments.summary(userId);
        assert.equal(summary.balance, 100);
        assert.equal(summary.deposits[0].status, "successful");
        const ledger = await query("SELECT count(*) FROM cash_wallet_ledger WHERE user_id = $1", [userId]);
        assert.equal(Number(ledger.rows[0].count), 1);
        const play = await query("SELECT balance FROM wallets WHERE user_id = $1", [userId]);
        assert.equal(Number(play.rows[0].balance), 1000);
        // A provider callback may arrive before the initiation response is saved.
        await query("UPDATE wallet_deposits SET created_at = NOW() - INTERVAL '2 minutes' WHERE user_id = $1", [userId]);
        earlyCallback = true;
        const early = await payments.initiate(userId, { ...request, requestKey: crypto.randomUUID() });
        assert.equal(early.status, "successful");
        assert.equal((await payments.summary(userId)).balance, 200);
    } finally {
        if (userId) {
            await query("DELETE FROM cash_wallet_ledger WHERE user_id = $1", [userId]);
            await query("DELETE FROM wallet_deposits WHERE user_id = $1", [userId]);
            await query("DELETE FROM cash_wallets WHERE user_id = $1", [userId]);
            await query("DELETE FROM wallets WHERE user_id = $1", [userId]);
            await query("DELETE FROM users WHERE id = $1", [userId]);
        }
        await closeDatabase();
    }
});
