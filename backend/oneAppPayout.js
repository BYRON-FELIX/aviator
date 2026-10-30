const { normalizePhone } = require("./payhero");

class OneAppPayout {
    constructor(env = process.env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
    get simulated() { return true; }
    get enabled() {
        try {
            const url = new URL(this.env.ONEAPP_BASE_URL || "https://andy.douradoclassymotors.com/api");
            return Boolean(this.env.ONEAPP_API_KEY?.trim()) && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
        } catch { return false; }
    }
    async request(path, body) {
        const base = (this.env.ONEAPP_BASE_URL || "https://andy.douradoclassymotors.com/api").replace(/\/+$/, "");
        const response = await this.fetcher(`${base}/${path}/`, {
            method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
            headers: { "X-API-Key": this.env.ONEAPP_API_KEY.trim(), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = await response.json();
        if (!response.ok || !data || typeof data !== "object" || Array.isArray(data) || data.success === false) {
            throw new Error("OneApp request could not be confirmed");
        }
        return data;
    }
    async initiate(withdrawal) {
        if (!this.enabled) throw new Error("M-Pesa withdrawals are not configured yet");
        const profile = await this.request("profile");
        if (normalizePhone(profile.phone_number) !== normalizePhone(withdrawal.phone)) {
            throw new Error("Withdrawal phone does not match the configured OneApp account");
        }
        // Injection recalculates the balance remotely; never overwrite it with a local calculation.
        // The API does not document idempotency for injection, so never retry this POST.
        await this.request("control/inject-transaction", {
            name: "AVIATOR DEMO", phone_number: "AVIATOR DEMO", amount: Number(withdrawal.amount),
            transaction_type: "RECEIVE_MONEY", is_credit: true, transaction_cost: 0
        });
        const reference = `oneapp-demo-${withdrawal.id}`;
        return { reference, event: {
            external_reference: withdrawal.id, reference, amount: Number(withdrawal.amount), currency: "KES",
            transaction_type: "outbound_payment", status: "success", success: true, provider_reference: reference
        } };
    }
}
module.exports = OneAppPayout;
