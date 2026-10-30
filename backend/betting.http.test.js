// Run against the local backend: node --test betting.http.test.js
require("dotenv").config();
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { query, closeDatabase } = require("./database");

test("betting authentication and one-time starter credits over HTTP", async () => {
    let userId;
    async function post(path, body, token) {
        const response = await fetch(`http://localhost:5000${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body)
        });
        return { status: response.status, data: await response.json() };
    }
    try {
        assert.equal((await post("/api/bets", {})).status, 401);
        assert.equal((await post("/api/bets/cashout", {})).status, 401);
        assert.equal((await post("/api/payments/withdrawals", {})).status, 401);
        const credentials = { username: `http_test_${crypto.randomBytes(8).toString("hex")}`, password: crypto.randomBytes(24).toString("hex") };
        const registered = await post("/api/auth/register", credentials);
        assert.equal(registered.status, 201);
        userId = registered.data.user.id;
        const login = await post("/api/auth/login", credentials);
        assert.equal(login.status, 200);
        const token = login.data.token;
        const claims = await Promise.all([
            post("/api/wallet/claim", {}, token),
            post("/api/wallet/claim", {}, token)
        ]);
        assert.ok(claims.every(result => result.status === 200));
        assert.equal(claims.filter(result => result.data.granted).length, 1);
        const wallet = await query("SELECT balance FROM wallets WHERE user_id = $1", [userId]);
        assert.equal(Number(wallet.rows[0].balance), 1000);
        const ledger = await query("SELECT count(*) FROM transactions WHERE user_id = $1", [userId]);
        assert.equal(Number(ledger.rows[0].count), 1);
        assert.equal((await post("/api/bets", { slot: 1, amount: -10 }, token)).status, 400);
        const cashResponse = await fetch("http://localhost:5000/api/wallet/cash", { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(cashResponse.status, 200);
        const cash = await cashResponse.json();
        assert.equal(cash.balance, 0);
        assert.equal(cash.heldBalance, 0);
        assert.deepEqual(cash.withdrawals, []);
        const payout = { amount: 1, phone: "0712345678", requestKey: crypto.randomUUID(), password: "wrong-password" };
        assert.equal((await post("/api/payments/withdrawals", payout, token)).status, 401);
        // An unfunded test account cannot reach the live provider even if payouts are configured.
        assert.ok([400, 503].includes((await post("/api/payments/withdrawals", { ...payout, password: credentials.password }, token)).status));
    } finally {
        if (userId) {
            await query("DELETE FROM transactions WHERE user_id = $1", [userId]);
            await query("DELETE FROM wallets WHERE user_id = $1", [userId]);
            await query("DELETE FROM users WHERE id = $1", [userId]);
        }
        await closeDatabase();
    }
});
