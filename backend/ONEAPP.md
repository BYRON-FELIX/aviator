# Simulated OneApp withdrawals

Add these settings to `backend/.env`, then restart the backend:

```env
WITHDRAWAL_PROVIDER=oneapp
ONEAPP_BASE_URL=https://andy.douradoclassymotors.com/api
ONEAPP_API_KEY=your_private_api_key
```

Create the key in your OneApp account using its API key management feature. Keep it on the backend. Each key identifies one account: withdrawals must use the phone number returned by that account's `/profile/` endpoint. Supporting multiple recipients requires separate account credentials or a recipient-routing API.

Use Wallet → Withdraw with an available cash balance and your game password. The backend checks the OneApp account phone, then posts a credit to `/control/inject-transaction/`. OneApp updates its simulated balance, statements, and mobile listeners. No real M-Pesa transfer occurs. Deposits retain their existing PayHero configuration.

The integration sends `RECEIVE_MONEY`, `is_credit: true`, zero transaction cost, and the sender label `AVIATOR DEMO`. The supplied documentation does not enumerate transaction types or define the injection response body; verify this type and a successful JSON response against your OneApp deployment before relying on it. The local receipt `oneapp-demo-<withdrawal UUID>` is an internal tracking reference, not an M-Pesa receipt.

Requests are not retried automatically: the injection endpoint documents no idempotency support. An unconfirmed outcome keeps funds on hold with status `unknown`. Check OneApp statements before manually reconciling; resending could duplicate the credit. This includes a process interruption after remote credit but before local confirmation. A phone mismatch or rejected API request also retains the hold for review under the existing withdrawal behavior.

Switch `WITHDRAWAL_PROVIDER=payhero` to use the existing payout integration. Do not switch providers while withdrawals are unresolved.

Run provider tests with `node --test oneAppPayout.test.js payheroPayout.test.js` from `backend`.
