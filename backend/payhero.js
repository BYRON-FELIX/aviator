const crypto = require("node:crypto");

function normalizePhone(value) {
    if (typeof value !== "string") throw new Error("Enter a valid Kenyan M-Pesa phone number");
    const digits = value.replace(/[\s+()-]/g, "");
    const phone = digits.startsWith("0") ? `254${digits.slice(1)}` : digits;
    if (!/^254[17]\d{8}$/.test(phone)) throw new Error("Enter a valid Kenyan M-Pesa phone number");
    return phone;
}

class PayHero {
    constructor(env = process.env, fetcher = fetch) {
        this.env = env;
        this.fetcher = fetcher;
    }
    get enabled() {
        const e = this.env;
        try {
            return e.PAYHERO_ENABLED === "true" && Boolean(e.PAYHERO_AUTH_TOKEN) &&
                /^[1-9]\d*$/.test(e.PAYHERO_CHANNEL_ID || "") &&
                new URL(e.PAYHERO_CALLBACK_BASE_URL).protocol === "https:";
        } catch { return false; }
    }
    async initiate(deposit, token) {
        if (!this.enabled) throw new Error("M-Pesa deposits are not configured yet");
        const callback = new URL(`/api/payments/payhero/callback/${deposit.id}/${token}`, this.env.PAYHERO_CALLBACK_BASE_URL);
        const response = await this.fetcher("https://backend.payhero.co.ke/api/v2/payments", {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
            headers: {
                Authorization: `Basic ${this.env.PAYHERO_AUTH_TOKEN.replace(/^Basic\s+/i, "")}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                amount: deposit.amount, phone_number: deposit.phone,
                channel_id: Number(this.env.PAYHERO_CHANNEL_ID), provider: "m-pesa",
                external_reference: deposit.id, callback_url: callback.toString()
            })
        });
        const body = await response.json();
        if (!response.ok || body.success !== true || !body.reference || !body.CheckoutRequestID) {
            throw new Error("M-Pesa request could not be confirmed. Check payment history before trying again.");
        }
        return { reference: String(body.reference), checkoutId: String(body.CheckoutRequestID) };
    }
}

const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
module.exports = { PayHero, normalizePhone, hashToken };
