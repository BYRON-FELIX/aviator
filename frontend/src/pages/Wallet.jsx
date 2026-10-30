import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Wallet as WalletIcon, Smartphone, RefreshCw, ShieldCheck } from "lucide-react";

const API_URL = "http://localhost:5000";
const money = value => new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES" }).format(Number(value || 0));
const labels = {
  created: "Preparing request", pending: "Awaiting payment", unknown: "Awaiting confirmation",
  successful: "Completed", failed: "Not completed", review: "Under review",
};

export default function Wallet({ token }) {
  const [wallet, setWallet] = useState(null);
  const [amount, setAmount] = useState("100");
  const [phone, setPhone] = useState("");
  const [mode, setMode] = useState("deposit");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(null);

  const load = useCallback(async signal => {
    const response = await fetch(`${API_URL}/api/wallet/cash`, {
      headers: { Authorization: `Bearer ${token}` }, signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load your wallet");
    setWallet(data);
  }, [token]);

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    async function update() {
      if (fetching) return;
      fetching = true;
      try { await load(controller.signal); }
      catch (error) { if (!controller.signal.aborted) setError(error.message); }
      finally { fetching = false; if (!controller.signal.aborted) setLoading(false); }
    }
    update();
    const timer = setInterval(update, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);

  async function submitPayment(event) {
    event.preventDefault();
    if (busy) return;
    const value = Number(amount);
    if (!Number.isInteger(value) || value < 1 || value > 150000) {
      setError("Enter a whole amount from KES 1 to 150,000."); return;
    }
    if (mode === "withdraw" && value > wallet.balance) {
      setError("The withdrawal exceeds your available cash balance."); return;
    }
    const details = `${mode}:${value}:${phone}`;
    if (requestRef.current?.details !== details) {
      requestRef.current = { details, key: crypto.randomUUID() };
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${API_URL}/api/payments/${mode === "withdraw" ? "withdrawals" : "deposits"}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ amount: value, phone, requestKey: requestRef.current.key, ...(mode === "withdraw" ? { password } : {}) }),
      });
      setPassword("");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to send payment request");
      const status = (mode === "withdraw" ? data.withdrawal : data.deposit).status;
      setNotice(mode === "withdraw" ? (status === "successful" ? (wallet?.withdrawalsSimulated ? "Simulated withdrawal completed. Check your OneApp balance and statements." : "Withdrawal completed. Check your M-Pesa messages.")
        : status === "failed" ? "Withdrawal failed. Reserved funds have been returned to your available balance."
        : "Withdrawal submitted. The amount is reserved while we confirm your payout. Do not submit it again.")
        : status === "successful" ? "Payment confirmed. Your balance has been updated."
        : status === "pending" ? "Check your phone and enter your M-Pesa PIN on the M-Pesa prompt."
        : status === "failed" ? "Payment was not completed. Review your history before starting another request."
        : "Your request is awaiting confirmation. Check your M-Pesa messages and payment history before trying again.");
      await load();
    } catch (error) {
      setError(error instanceof TypeError ? "Connection interrupted. Check payment history before retrying." : error.message);
    } finally { setBusy(false); setPassword(""); }
  }

  return (
    <div className="wallet-page">
      <header className="wallet-topbar">
        <Link to="/" className="back-link"><ArrowLeft size={17} /> Back to game</Link>
        <span className="wallet-provider"><ShieldCheck size={16} /> M-Pesa · PayHero</span>
      </header>
      <main className="wallet-main">
        <div className="wallet-title"><div><span className="wallet-eyebrow">YOUR ACCOUNT</span><h1>Wallet</h1></div><WalletIcon size={28} /></div>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <div className="wallet-grid">
          <section className="wallet-balance-card">
            <span>Balance</span>
            <strong>{loading ? "Loading..." : wallet ? money(wallet.balance) : "Unavailable"}</strong>
            <span className="wallet-held">On hold for withdrawals: {money(wallet?.heldBalance)}</span>
            <p>Deposited funds are held separately from your play balance.</p>
            <span className="wallet-currency">KES · Kenyan shillings</span>
          </section>
          <section className="wallet-deposit-card">
            <div className="wallet-action-options" role="group" aria-label="Wallet action">
              {["deposit", "withdraw"].map(value => <button key={value} type="button" aria-pressed={mode === value}
                className={mode === value ? "active" : ""} disabled={busy}
                onClick={() => { setMode(value); setPassword(""); setError(""); setNotice(""); }}>
                {value === "deposit" ? "Deposit" : "Withdraw"}
              </button>)}
            </div>
            <h2><Smartphone size={21} /> {mode === "withdraw" ? (wallet?.withdrawalsSimulated ? "Simulate a OneApp withdrawal" : "Withdraw to M-Pesa") : "Deposit via M-Pesa"}</h2>
            <p>{mode === "withdraw" ? (wallet?.withdrawalsSimulated ? "Demo only: credits your connected OneApp account. No real M-Pesa money is sent. Use the phone number on that account." : "Send money from your available cash balance to your phone.") : "Receive a payment prompt on your phone."}</p>
            {wallet && !(mode === "withdraw" ? wallet.withdrawalsEnabled : wallet.depositsEnabled) && <div className="wallet-notice">M-Pesa {mode === "withdraw" ? "withdrawals" : "deposits"} are not available yet.</div>}
            <form onSubmit={submitPayment} className="auth-form">
              <label htmlFor="deposit-amount">Amount (KES)</label>
              <input id="deposit-amount" type="number" min="1" max="150000" step="1" required value={amount} onChange={event => { setAmount(event.target.value); requestRef.current = null; }} disabled={busy} />
              <label htmlFor="deposit-phone">M-Pesa phone number</label>
              <input id="deposit-phone" type="tel" autoComplete="tel" placeholder="0712 345 678" required value={phone} onChange={event => { setPhone(event.target.value); requestRef.current = null; }} disabled={busy} />
              {mode === "withdraw" && <>
                <label htmlFor="withdraw-password">Confirm your account password</label>
                <input id="withdraw-password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
                <p className="withdraw-summary">{wallet?.withdrawalsSimulated ? `${money(amount)} will be credited to your simulated OneApp account for ${phone || "your linked phone number"}.` : `${money(amount)} will be sent to ${phone || "your M-Pesa number"}.`} The amount stays on hold until the payout is confirmed.</p>
              </>}
              <button className="auth-submit" type="submit" disabled={busy || !(mode === "withdraw" ? wallet?.withdrawalsEnabled : wallet?.depositsEnabled)}>{busy ? "Submitting request..." : mode === "withdraw" ? `Withdraw ${money(amount)}` : "Send M-Pesa prompt"}</button>
            </form>
            {notice && <div className="wallet-notice" role="status">{notice}</div>}
            <p className="wallet-security">{mode === "withdraw" ? "Confirm the recipient number before withdrawing. Your M-Pesa PIN is never required here." : "Enter your PIN only in the M-Pesa prompt. We never ask for your PIN."}</p>
          </section>
        </div>
        <section className="wallet-history">
          <div className="wallet-history-heading"><h2>Deposit history</h2><button className="refresh-button" type="button" onClick={() => load().catch(error => setError(error.message))}><RefreshCw size={15} /> Refresh</button></div>
          <div className="admin-table-wrapper"><table className="admin-table">
            <thead><tr><th>Date</th><th>Amount</th><th>Phone</th><th>Status</th><th>M-Pesa receipt</th></tr></thead>
            <tbody>{wallet?.deposits.length ? wallet.deposits.map(item => <tr key={item.id}>
              <td>{new Date(item.createdAt).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</td>
              <td>{money(item.amount)}</td><td>{item.phone}</td>
              <td><span className={`deposit-status ${item.status}`}>{labels[item.status] || item.status}</span></td>
              <td>{item.receipt || "—"}</td>
            </tr>) : <tr><td colSpan="5" className="empty-table">{loading ? "Loading deposits..." : "Your deposits will appear here."}</td></tr>}</tbody>
          </table></div>
        </section>
        <section className="wallet-history">
          <div className="wallet-history-heading"><h2>Withdrawal history</h2></div>
          <div className="admin-table-wrapper"><table className="admin-table">
            <thead><tr><th>Date</th><th>Amount</th><th>Recipient</th><th>Status</th><th>Receipt</th></tr></thead>
            <tbody>{wallet?.withdrawals?.length ? wallet.withdrawals.map(item => <tr key={item.id}>
              <td>{new Date(item.createdAt).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</td>
              <td>{money(item.amount)}</td><td>{item.phone}</td>
              <td><span className={`deposit-status ${item.status}`}>{item.status === "pending" ? "Processing payout" : labels[item.status] || item.status}</span></td>
              <td>{item.receipt || "—"}</td>
            </tr>) : <tr><td colSpan="5" className="empty-table">{loading ? "Loading withdrawals..." : "Your withdrawals will appear here."}</td></tr>}</tbody>
          </table></div>
        </section>
      </main>
    </div>
  );
}
