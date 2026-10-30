class PayHeroPayout {
    constructor(env = process.env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
    get enabled() {
        const e = this.env;
        try {
            return e.PAYHERO_PAYOUT_ENABLED === "true" && Boolean(e.PAYHERO_PAYOUT_AUTH_TOKEN) &&
                /^[1-9]\d*$/.test(e.PAYHERO_PAYOUT_ACCOUNT_ID || "") &&
                /^\d+$/.test(e.PAYHERO_PAYOUT_NETWORK_CODE || "") &&
                ["https://api.payhero.africa", "https://api.finoq.africa"].includes(e.PAYHERO_PAYOUT_BASE_URL) &&
                new URL(e.PAYHERO_CALLBACK_BASE_URL).protocol === "https:";
        } catch { return false; }
    }
    async initiate(withdrawal, token) {
        if (!this.enabled) throw new Error("M-Pesa withdrawals are not configured yet");
        const callback = new URL(`/api/payments/payhero/withdrawal-callback/${withdrawal.id}/${token}`, this.env.PAYHERO_CALLBACK_BASE_URL);
        const response = await this.fetcher(`${this.env.PAYHERO_PAYOUT_BASE_URL}/api/v2/withdraw`, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
            headers: { "Content-Type": "application/json", Authorization: `Basic ${this.env.PAYHERO_PAYOUT_AUTH_TOKEN.replace(/^Basic\s+/i, "")}` },
            body: JSON.stringify({
                external_reference: withdrawal.id, account_id: Number(this.env.PAYHERO_PAYOUT_ACCOUNT_ID),
                amount: withdrawal.amount, phone_number: withdrawal.phone, account_number: withdrawal.phone,
                network_code: this.env.PAYHERO_PAYOUT_NETWORK_CODE, channel: "phone", recipient_type: "MSISDN",
                callback_url: callback.toString()
            })
        });
        const data = await response.json();
        if (!response.ok || data.status !== "QUEUED" || !data.merchant_reference || data.external_reference !== withdrawal.id) {
            throw new Error("Payout acceptance could not be confirmed");
        }
        return { reference: String(data.merchant_reference) };
    }
}
module.exports = PayHeroPayout;
