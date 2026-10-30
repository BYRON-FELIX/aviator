const { test } = require("node:test");
const assert = require("node:assert/strict");
const OneAppPayout = require("./oneAppPayout");
const env = { ONEAPP_API_KEY: "test-only" };
const withdrawal = { id: "withdrawal-id", amount: "100.00", phone: "254712345678" };

test("simulation requires a server key and HTTPS", async () => {
    assert.equal(new OneAppPayout({}).enabled, false);
    assert.equal(new OneAppPayout({ ...env, ONEAPP_BASE_URL: "http://example.com/api" }).enabled, false);
    await assert.rejects(new OneAppPayout({}).initiate(withdrawal), /not configured/);
});

test("credits the matching account and returns a settlement event", async () => {
    const calls = [];
    const provider = new OneAppPayout(env, async (url, options) => {
        calls.push(url);
        assert.equal(options.headers["X-API-Key"], "test-only");
        assert.equal(options.redirect, "error");
        if (options.method === "GET") return { ok: true, json: async () => ({ phone_number: "0712345678" }) };
        assert.deepEqual(JSON.parse(options.body), { name: "AVIATOR DEMO", phone_number: "AVIATOR DEMO", amount: 100,
            transaction_type: "RECEIVE_MONEY", is_credit: true, transaction_cost: 0 });
        return { ok: true, json: async () => ({ success: true }) };
    });
    const result = await provider.initiate(withdrawal);
    assert.equal(provider.simulated, true);
    assert.deepEqual(calls, ["https://andy.douradoclassymotors.com/api/profile/", "https://andy.douradoclassymotors.com/api/control/inject-transaction/"]);
    assert.equal(result.event.external_reference, withdrawal.id);
    assert.equal(result.event.reference, result.reference);
    assert.equal(result.event.amount, 100);
    assert.equal(result.event.success, true);
});

test("a mismatched recipient never triggers injection", async () => {
    let calls = 0;
    const provider = new OneAppPayout(env, async () => {
        calls++;
        return { ok: true, json: async () => ({ phone_number: "0799999999" }) };
    });
    await assert.rejects(provider.initiate(withdrawal), /does not match/);
    assert.equal(calls, 1);
});

test("timeouts and rejected injections never retry or settle", async () => {
    for (const behavior of ["timeout", "http", "rejected", "malformed"]) {
        let injections = 0;
        const provider = new OneAppPayout(env, async (url, options) => {
            if (options.method === "GET") return { ok: true, json: async () => ({ phone_number: "0712345678" }) };
            injections++;
            if (behavior === "timeout") throw new Error("timeout");
            return { ok: behavior !== "http", json: async () => behavior === "malformed" ? null : { success: behavior !== "rejected" } };
        });
        await assert.rejects(provider.initiate(withdrawal));
        assert.equal(injections, 1);
    }
});
