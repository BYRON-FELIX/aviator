const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PayHero, normalizePhone } = require("./payhero");

test("M-Pesa phone normalization and rejection", () => {
    for (const phone of ["0712 345 678", "+254712345678", "254712345678"]) {
        assert.equal(normalizePhone(phone), "254712345678");
    }
    assert.equal(normalizePhone("0112345678"), "254112345678");
    for (const phone of ["123", "254212345678", null, "07123456789"]) {
        assert.throws(() => normalizePhone(phone), /valid Kenyan/);
    }
});

test("disabled configuration cannot send an STK prompt", async () => {
    const provider = new PayHero({}, () => { throw new Error("Must not call network"); });
    assert.equal(provider.enabled, false);
    await assert.rejects(provider.initiate({}, "token"), /not configured/);
});

test("PayHero request keeps credentials and callback token on server", async () => {
    const provider = new PayHero({ PAYHERO_ENABLED: "true", PAYHERO_AUTH_TOKEN: "Basic test-token",
        PAYHERO_CHANNEL_ID: "133", PAYHERO_CALLBACK_BASE_URL: "https://api.example.com" }, async (url, options) => {
        assert.equal(url, "https://backend.payhero.co.ke/api/v2/payments");
        assert.equal(options.headers.Authorization, "Basic test-token");
        const body = JSON.parse(options.body);
        assert.equal(body.amount, 100);
        assert.equal(body.channel_id, 133);
        assert.equal(body.provider, "m-pesa");
        assert.equal(body.external_reference, "deposit-id");
        assert.equal(body.callback_url, "https://api.example.com/api/payments/payhero/callback/deposit-id/secret");
        return { ok: true, json: async () => ({ success: true, reference: "provider-id", CheckoutRequestID: "checkout-id" }) };
    });
    assert.deepEqual(await provider.initiate({ id: "deposit-id", amount: 100, phone: "254712345678" }, "secret"),
        { reference: "provider-id", checkoutId: "checkout-id" });
});
