const { test } = require("node:test");
const assert = require("node:assert/strict");
const PayHeroPayout = require("./payheroPayout");

test("payout credentials are independent and disabled by default", async () => {
    const provider = new PayHeroPayout({ PAYHERO_ENABLED: "true", PAYHERO_AUTH_TOKEN: "collection-key" });
    assert.equal(provider.enabled, false);
    await assert.rejects(provider.initiate({}, "token"), /not configured/);
});

test("payout request uses documented Kenya phone destination and matches queued reference", async () => {
    const provider = new PayHeroPayout({ PAYHERO_PAYOUT_ENABLED: "true", PAYHERO_PAYOUT_AUTH_TOKEN: "test-only",
        PAYHERO_PAYOUT_ACCOUNT_ID: "63", PAYHERO_PAYOUT_NETWORK_CODE: "63902",
        PAYHERO_PAYOUT_BASE_URL: "https://api.payhero.africa", PAYHERO_CALLBACK_BASE_URL: "https://api.example.com" },
    async (url, options) => {
        assert.equal(url, "https://api.payhero.africa/api/v2/withdraw");
        assert.equal(options.headers.Authorization, "Basic test-only");
        const body = JSON.parse(options.body);
        assert.equal(body.account_id, 63);
        assert.equal(body.account_number, "254712345678");
        assert.equal(body.recipient_type, "MSISDN");
        assert.equal(body.channel, "phone");
        assert.equal(body.amount, 100);
        assert.equal(body.callback_url, "https://api.example.com/api/payments/payhero/withdrawal-callback/withdrawal-id/secret");
        return { ok: true, json: async () => ({ status: "QUEUED", merchant_reference: "merchant-id", external_reference: "withdrawal-id" }) };
    });
    assert.deepEqual(await provider.initiate({ id: "withdrawal-id", amount: 100, phone: "254712345678" }, "secret"), { reference: "merchant-id" });
});
