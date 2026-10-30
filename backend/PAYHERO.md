# Wallet deposits with PayHero

The `/wallet` page shows a **KES cash balance** and deposit history. The game uses
the existing **play balance**. Free starter credits and game payouts never enter
the cash wallet; deposited money cannot be wagered through the existing simulation.

## Setup

1. Run `node migration007.js` from `backend`.
2. Add the settings from `.env.payhero.example` to `backend/.env`.
3. Obtain a Basic authorization token and payment channel ID from your PayHero account.
   `PAYHERO_CALLBACK_BASE_URL` must be this backend's public HTTPS origin. Localhost
   cannot receive PayHero callbacks. Keep callback URLs secret: they contain a
   cryptographically random, per-deposit authentication token.
4. Set `PAYHERO_ENABLED=true` and restart the backend only when you intend to send
   real STK prompts. The documented endpoint is production; no sandbox is assumed.
5. Verify a small deposit using your own account and confirm the receipt, amount,
   callback and wallet ledger in both systems before inviting deposits.

No live payments were sent during development. Missing credentials disable deposits
with an explicit message. No existing play balances are converted to cash.

## Deposit flow

- `GET /api/wallet/cash`: authenticated account's KES balance and latest 50 deposits.
- `POST /api/payments/deposits` (also `/api/wallet/deposit`): authenticated JSON body
  `{ "amount": 100, "phone": "0712345678", "requestKey": "<UUID>" }`.
- Reuse the request key after a network failure. A repeated key cannot send another
  prompt; changed payment details with the same key are rejected.
- Amounts are whole KES, from 1 to 150,000. The channel/provider may enforce stricter limits.
- Requests are limited to one prompt per user/phone per minute. The server sends a
  unique external reference, never a client-selected user ID or payment success flag.
- A queued STK request does **not** credit a balance. Only a matching authenticated
  callback credits it. The amount, phone, external reference, checkout ID and receipt
  are checked; deposit, wallet and ledger changes commit atomically.
- Callbacks are authenticated using a 256-bit token sent only to PayHero in the
  callback URL. Its hash is stored in the database. This is application-level URL
  authentication, not a claim that PayHero signs callbacks. Avoid URL logging at the proxy.
- Early callbacks are saved and processed after the checkout ID is known. A worker
  replays stored callbacks every 30 seconds. Duplicate callbacks cannot double-credit.
- Timeouts remain `unknown`, never automatically retry the charge. Missing callbacks,
  unknown payments and mismatches require reconciliation against PayHero's dashboard.
  There is no automatic provider-status reconciliation in this version.
- Real-money wagering is outside this wallet integration.

## Withdrawals

Run `node migration008.js` after migration 007. The wallet now includes a Withdraw
form, held-funds display and withdrawal history. Requests require the account
password as well as the login token. Only confirmed cash, never play credits, can
be withdrawn. Amounts are whole KES from 1 to 150,000, subject to provider limits.

Configure the separate `PAYHERO_PAYOUT_*` settings in `.env.payhero.example`. The
Kenya payout API uses an account ID and network code, not the collection channel
ID. Confirm the payout host and credentials for your account with PayHero; official
documentation references both `https://api.payhero.africa` and
`https://api.finoq.africa`. The implementation accepts only these hosts and does
not send your collection credentials to them automatically. Fund the payout account
and account for provider charges before enabling withdrawals; this implementation
does not deduct additional platform fees from the requested user amount.

- `POST /api/payments/withdrawals`: authenticated JSON `{ amount, phone, requestKey, password }`.
- Available balance is atomically reduced and the amount placed on hold before
  contacting the provider. Concurrent requests cannot spend the same balance twice.
- Request keys prevent duplicate payouts. Only one unresolved withdrawal per user
  is allowed, with a one-minute cooldown after each request.
- Confirmed success releases the hold without a second debit; confirmed failure
  refunds it once. Authenticated callbacks must match the outbound type, reference,
  amount and KES currency. Callback URL tokens are treated as secrets, as for deposits.
- Timeouts or unrecognized responses keep funds on hold and require reconciliation
  with the provider; never resend payouts or release holds based on an HTTP timeout.
- Missing callbacks and conflicting final notifications require manual provider
  reconciliation. No automatic payout status-query or operator adjustment UI is included.
- No live payout has been sent. Enable only after confirming the provider account
  settings and testing a small payout with your own account.

Tests: `node --test payheroPayout.test.js` and
`node --test withdrawals.integration.test.js` (fake provider, temporary DB account).

Payout references:
- https://docs.payhero.africa/kenya/payouts/
- https://docs.payhero.africa/api-reference/webhooks/transactioncallback/

## Verification

`node --test payhero.test.js` uses a fake provider, not live credentials.
`node --test payments.integration.test.js` exercises the database ledger with a fake
provider and removes its own test account afterward. It requires database access.

Official references:
- https://docs.payhero.co.ke/docs/post-initiate-mpesa-stk-push-request
- https://docs.payhero.co.ke/docs/payment-callback
- https://docs.payhero.co.ke/docs/authorization
