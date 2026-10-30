import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plane,
  Wallet,
  History,
  LogIn,
  LogOut,
  Settings,
  Wifi,
  WifiOff,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router-dom";

const API_URL = "http://localhost:5000";
const WS_URL = "ws://localhost:5000";

function formatMultiplier(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}x` : "1.00x";
}

function formatBalance(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function FlightGraph({ multiplier, running }) {
  const target = Math.max(1, Number(multiplier) || 1);
  const [flight, setFlight] = useState({ value: target, departure: 0 });
  const sampleRef = useRef({ value: target, receivedAt: 0, running });

  useEffect(() => {
    sampleRef.current = { value: target, receivedAt: performance.now(), running };
  }, [target, running]);

  useEffect(() => {
    let frame;
    let previousTime;
    let departureStarted;
    function animate(time) {
      const elapsed = previousTime === undefined ? 0 : Math.min(time - previousTime, 100);
      previousTime = time;
      const sample = sampleRef.current;
      if (!sample.running && departureStarted === undefined) departureStarted = time;
      setFlight(current => {
        if (!sample.running) {
          return { ...current, departure: Math.min(1, (time - departureStarted) / 650) };
        }
        // Match the engine's exponential growth between network messages.
        // Stop extrapolating after a stale connection instead of inventing an endless flight.
        const age = Math.max(0, Math.min(time - sample.receivedAt, 750));
        const estimate = sample.value * Math.exp(age / 10000);
        if (age >= 750) return { value: Math.max(current.value, estimate), departure: 0 };
        const advanced = current.value * Math.exp(elapsed / 10000);
        const corrected = advanced + (estimate - advanced) * (1 - Math.exp(-elapsed / 180));
        return { value: Math.max(current.value, corrected), departure: 0 };
      });
      if (sample.running || time - departureStarted < 650) frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);

  // A fixed scale keeps the growing trail anchored to the takeoff point.
  const progress = 1 - Math.exp(-Math.log(flight.value) / 2);
  const point = t => [50 + 880 * t, 350 - 290 * t ** 1.65];
  const [x, y] = point(progress);
  const points = Array.from({ length: 65 }, (_, index) => point(progress * index / 64));
  const path = points.map(([px, py], index) => `${index ? "L" : "M"} ${px} ${py}`).join(" ");
  const angle = Math.atan2(-290 * 1.65 * progress ** 0.65, 880) * 180 / Math.PI;

  return (
    <svg className="flight-graph" viewBox="0 0 1000 400" aria-hidden="true">
      <path className="flight-axis" d="M 50 35 V 350 H 955" />
      <path className="flight-area" d={`${path} L ${x} 350 Z`} />
      <path className="flight-trail" d={path} />
      <circle className="flight-origin" cx="50" cy="350" r="4" />
      {flight.departure < 1 && (
        <g transform={`translate(${x + 1200 * flight.departure ** 1.5} ${y - 650 * flight.departure ** 1.5}) rotate(${angle + 45 - 15 * flight.departure})`}>
          <Plane className="flight-plane" x={-26} y={-26} size={52} strokeWidth={2.5} />
        </g>
      )}
    </svg>
  );
}

function BetPanel({ slot, round, user, bet, onPlace, onCashout }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = bet?.status === "active";
  const canPlace = user && round?.status === "waiting" && !bet;
  const canCashout = user && round?.status === "running" && active;
  const disabled = busy || !(canPlace || canCashout);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (canCashout) await onCashout(bet.id);
      else await onPlace({ slot, roundNumber: round.roundNumber, amount: Number(amount),
        autoCashout: cashoutMode === "auto" ? Number(autoCashout) : null });
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  const [amount, setAmount] = useState(10);
  const [autoCashout, setAutoCashout] = useState(2);
  const [cashoutMode, setCashoutMode] = useState("manual");
  const selectedMode = bet ? (bet.autoCashout == null ? "manual" : "auto") : cashoutMode;

  const adjustAmount = (factor) => {
    setAmount((current) =>
      Math.max(1, Math.round(Number(current || 1) * factor * 100) / 100)
    );
  };

  return (
    <div className="bet-panel">
      <div className="bet-panel-header">
        <span className="bet-panel-title">Bet {slot}</span>
        <span className="bet-panel-status">{bet ? (bet.status === "active" ? "Placed" : bet.status === "cashed_out" ? "Cashed out" : bet.status === "lost" ? "Lost" : "Refunded") : "Ready"}</span>
      </div>

      <fieldset className="bet-panel-fields bet-fields" disabled={busy || Boolean(bet)}>
        <div className="bet-amount-section">
          <label>Bet amount</label>

          <div className="bet-input-row">
            <button type="button" onClick={() => adjustAmount(0.5)}>
              −
            </button>

            <input
              type="number"
              min="1"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />

            <button type="button" onClick={() => adjustAmount(2)}>
              +
            </button>
          </div>

          <div className="quick-bets">
            {[10, 20, 50, 100].map((value) => (
              <button
                type="button"
                key={value}
                onClick={() => setAmount(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="auto-cashout-section">
          <fieldset className="cashout-mode">
            <legend>Cash out</legend>
            <div className="cashout-options">
              {["manual", "auto"].map(mode => (
                <label key={mode} className={selectedMode === mode ? "selected" : ""}>
                  <input
                    type="radio"
                    name={`cashout-mode-${slot}`}
                    value={mode}
                    checked={selectedMode === mode}
                    onChange={() => setCashoutMode(mode)}
                  />
                  {mode === "manual" ? "Manual" : "Auto"}
                </label>
              ))}
            </div>
          </fieldset>

          {selectedMode === "auto" ? <>
          <label htmlFor={`cashout-target-${slot}`}>Target multiplier</label>
          <div className="auto-cashout-input">
            <input
              id={`cashout-target-${slot}`}
              type="number"
              min="1.01"
              step="0.01"
              value={bet?.autoCashout ?? autoCashout}
              onChange={(event) => setAutoCashout(event.target.value)}
            />
            <span>x</span>
          </div>

          <p>Cash out at your selected multiplier.</p>
          </> : <p>Choose when to cash out during the flight.</p>}
        </div>
      </fieldset>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {bet?.status === "cashed_out" && <p className="bet-result">Won {formatBalance(bet.payout)} credits at {formatMultiplier(bet.cashOutMultiplier)}</p>}
      {bet?.status === "lost" && <p className="bet-result">Round ended - {formatBalance(bet.amount)} credits lost</p>}
      <button
        type="button"
        onClick={submit}
        className={`place-bet-button ${canCashout ? "cashout-button" : ""}`}
        disabled={disabled}
      >
        <span>{busy ? (active ? "Cashing out..." : "Placing bet...") : !user ? "Log in to bet" : canCashout ? "Cash out" : active ? "Bet placed" : bet ? "Round settled" : canPlace ? "Place Bet" : "Next round soon"}</span>
        <strong>{formatBalance(canCashout ? bet.amount * (round.multiplier || 1) : bet?.amount ?? amount)} credits</strong>
      </button>

    </div>
  );
}

export default function Game({ user, token, onLogout }) {
  const [round, setRound] = useState(null);
  const [history, setHistory] = useState([]);
  const [connected, setConnected] = useState(false);
  const [balance, setBalance] = useState(null);
  const [playerBets, setPlayerBets] = useState([]);
  const [accountError, setAccountError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [creditNotice, setCreditNotice] = useState("");
  const [activeTab, setActiveTab] = useState("all");

  const socketRef = useRef(null);
  const accountRevision = useRef(0);
  const isAdmin = user?.role === "admin";


  useEffect(() => {
    let cancelled = false;
    let reconnectTimer;
    let socket;
    const historyUrl = `${API_URL}${isAdmin ? "/api/admin/simulation/history" : "/api/game/history"}`;
    const historyOptions = isAdmin ? { headers: { Authorization: `Bearer ${token}` } } : {};


    async function loadInitialState() {
      try {
        const [gameResponse, historyResponse] = await Promise.all([
          fetch(`${API_URL}/api/game`),
          fetch(historyUrl, historyOptions),
        ]);

        if (!gameResponse.ok || !historyResponse.ok) {
          throw new Error("Unable to load game state");
        }

        const gameData = await gameResponse.json();
        const historyData = await historyResponse.json();

        if (!cancelled) {
          setRound(gameData.round);
          setHistory(historyData.history || []);
        }
      } catch (error) {
        console.error("Game loading error:", error.message);
      }
    }

    function connectWebSocket() {
      if (cancelled) return;

      socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        if (!cancelled) setConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (
            message.type === "game_state" ||
            message.type === "game_update"
          ) {
            if (message.round) {
              setRound(message.round);
            }

            if (
  message.event === "crashed" ||
  message.event?.type === "crashed"
) {
              fetch(historyUrl, historyOptions)
                .then((response) => response.json())
                .then((data) => {
                  if (!cancelled) {
                    setHistory(data.history || []);
                  }
                })
                .catch(console.error);
            }
          }
        } catch (error) {
          console.error("WebSocket message error:", error);
        }
      };

      socket.onclose = () => {
        if (cancelled) return;

        setConnected(false);

        reconnectTimer = setTimeout(connectWebSocket, 3000);
      };

      socket.onerror = () => {
        socket.close();
      };
    }

    loadInitialState();
    connectWebSocket();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [isAdmin, token]);

  const accountRequest = useCallback(async (path, body) => {
    const response = await fetch(`${API_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }, [token]);

  const refreshAccount = useCallback(async () => {
    if (!user || !token) return;
    const revision = accountRevision.current;
    const [walletData, betsData] = await Promise.all([
      accountRequest(`/api/wallet/${user.id}`),
      accountRequest(`/api/users/${user.id}/bets`),
    ]);
    if (revision !== accountRevision.current) return;
    setBalance(walletData.wallet.balance);
    setPlayerBets(betsData.bets);
  }, [user, token, accountRequest]);

  useEffect(() => {
    if (!user || !token) return;
    let cancelled = false;
    async function update() {
      const revision = accountRevision.current;
      try {
        const [walletData, betsData] = await Promise.all([
          accountRequest(`/api/wallet/${user.id}`),
          accountRequest(`/api/users/${user.id}/bets`),
        ]);
        if (!cancelled && revision === accountRevision.current) {
          setBalance(walletData.wallet.balance);
          setPlayerBets(betsData.bets);
        }
      } catch (error) { if (!cancelled) setAccountError(error.message); }
    }
    update();
    const timer = setInterval(update, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [user, token, accountRequest]);

  async function placeBet(body) {
    const data = await accountRequest("/api/bets", body);
    accountRevision.current += 1;
    setPlayerBets(current => [data.bet, ...current.filter(bet => bet.id !== data.bet.id)]);
    refreshAccount().catch(error => setAccountError(error.message));
  }
  async function cashOut(betId) {
    const data = await accountRequest("/api/bets/cashout", { betId });
    accountRevision.current += 1;
    setPlayerBets(current => current.map(bet => bet.id === data.bet.id ? data.bet : bet));
    setBalance(data.wallet.balance);
  }
  async function claimCredits() {
    setClaiming(true);
    setAccountError("");
    try {
      const data = await accountRequest("/api/wallet/claim", {});
      accountRevision.current += 1;
      setCreditNotice(data.granted ? "1,000 credits added to your balance." : "Your starter credits have already been claimed.");
      await refreshAccount();
    } catch (error) { setAccountError(error.message); }
    finally { setClaiming(false); }
  }

  const status = round?.status || "waiting";
  const multiplier = round?.multiplier || 1;
  const isRunning = status === "running";
  const isCrashed = status === "crashed";
  const isWaiting = status === "waiting";

  return (
    <div className="game-page">
      <header className="game-header">
        <div className="game-brand">
          <div className="brand-icon">
            <Plane size={22} />
          </div>

          <div>
            <h1>AVIATOR</h1>
            <span>LIVE FLIGHT</span>
          </div>
        </div>

        <div className="game-header-actions">
          <div
            className={`connection-indicator ${
              connected ? "online" : "offline"
            }`}
          >
            {connected ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>{connected ? "Live" : "Reconnecting"}</span>
          </div>

          {user && (
            <Link to="/wallet" className="wallet-display" title="Open wallet">
              <Wallet size={17} />
              <span>Play balance {formatBalance(balance)}</span>
            </Link>
          )}

          {user?.role === "admin" && (
            <Link to="/admin" className="header-icon-button" title="Admin">
              <Settings size={19} />
            </Link>
          )}

          {user ? (
            <button
              type="button"
              className="header-icon-button"
              onClick={onLogout}
              title="Logout"
            >
              <LogOut size={19} />
            </button>
          ) : (
            <Link to="/login" className="login-button">
              <LogIn size={16} />
              Login
            </Link>
          )}
        </div>
      </header>

      <main className="game-content">
        <section className="game-main">
          <div className="round-history-bar">
            <div className="history-label">
              <History size={15} />
              <span>Previous rounds</span>
            </div>

            <div className="history-multipliers">
              {history.slice(0, 12).map((item) => (
                <span
                  key={item.roundNumber}
                  className={`history-pill ${
                    Number(item.crashPoint) >= 10
                      ? "high"
                      : Number(item.crashPoint) >= 2
                      ? "medium"
                      : "low"
                  }`}
                  title={
                    isAdmin ? (item.generationMode === "manual"
                      ? "Admin-controlled simulation"
                      : "Automatic simulation") : "Virtual-credit simulation"
                  }
                >
                  {item.crashPoint
                    ? formatMultiplier(item.crashPoint)
                    : "—"}
                  {isAdmin && item.generationMode === "manual" ? " *" : ""}
                </span>
              ))}
            </div>
          </div>

          <div className={`flight-stage ${status}`}>
            <div className="flight-stage-grid" />
            {(isRunning || isCrashed) && (
              <FlightGraph
                key={round?.roundNumber}
                multiplier={isCrashed ? round?.crashPoint : multiplier}
                running={isRunning}
              />
            )}

            <div className="flight-stage-top">
              <span>
                ROUND #{round?.roundNumber ?? "—"}
              </span>

              <span className="simulation-status">
                <ShieldCheck size={14} />
                CREDITS
              </span>
            </div>

            <div className="flight-stage-center">
              {isWaiting && (
                <>
                  <div className="waiting-caption">
                    WAITING FOR NEXT ROUND
                  </div>

                  <div className="countdown-number">
                    {round?.countdown ?? 10}
                  </div>

                  <div className="countdown-progress">
                    <div
                      style={{
                        width: `${
                          Math.max(
                            0,
                            Math.min(100, (round?.countdown ?? 10) * 10)
                          )
                        }%`,
                      }}
                    />
                  </div>
                </>
              )}

              {isRunning && (
                <>
                  <div className="multiplier-label">
                    CURRENT MULTIPLIER
                  </div>

                  <div className="live-multiplier">
                    {formatMultiplier(multiplier)}
                  </div>

                </>
              )}

              {isCrashed && (
                <>
                  <div className="crash-label">
                    FLEW AWAY!
                  </div>

                  <div className="crashed-multiplier">
                    {formatMultiplier(round?.crashPoint)}
                  </div>

                  <div className="crash-subtitle">
                    Round completed
                  </div>
                </>
              )}
            </div>

            <div className="flight-stage-bottom">
              <span>
                LIVE ROUND
              </span>

              <span>
                {connected ? "● Connected" : "○ Disconnected"}
              </span>
            </div>
          </div>

          <div className="betting-status" role="status">
            <span className="status-dot" />
            {user ? "Place bets before takeoff. Cash out during the flight or set an automatic target." : <Link to="/login">Log in to place a bet.</Link>}
            {user && <button className="credit-claim" type="button" disabled={claiming} onClick={claimCredits}>{claiming ? "Claiming..." : "Claim 1,000 free credits"}</button>}
          </div>
          {accountError && <div className="auth-error" role="alert">{accountError}</div>}
          {creditNotice && <p className="bet-result" role="status">{creditNotice}</p>}
          <div className="bet-panels">
            {[1, 2].map(slot => <BetPanel key={`${user?.id}-${round?.roundNumber}-${slot}`}
              slot={slot} round={round} user={user}
              bet={user ? playerBets.find(bet => bet.userId === user.id && bet.roundNumber === round?.roundNumber && bet.slot === slot) : null}
              onPlace={placeBet} onCashout={cashOut} />)}
          </div>
        </section>

        <aside className={`game-sidebar ${isAdmin ? "" : "player-history"}`}>
          <div className="sidebar-header">
            <h2>Game History</h2>
            <span>Recent rounds</span>
          </div>

          {isAdmin && <div className="history-tabs">
            <button
              type="button"
              className={activeTab === "all" ? "active" : ""}
              onClick={() => setActiveTab("all")}
            >
              All
            </button>

            <button
              type="button"
              className={activeTab === "automatic" ? "active" : ""}
              onClick={() => setActiveTab("automatic")}
            >
              Automatic
            </button>

            <button
              type="button"
              className={activeTab === "manual" ? "active" : ""}
              onClick={() => setActiveTab("manual")}
            >
              Manual
            </button>
          </div>}

          <div className="history-table-header">
            <span>Round</span>
            {isAdmin && <span>Mode</span>}
            <span>Result</span>
          </div>

          <div className="history-table-body">
            {history.length === 0 && <p className="history-empty">Completed rounds will appear here.</p>}
            {history
              .filter(
                (item) =>
                  !isAdmin || activeTab === "all" ||
                  item.generationMode === activeTab
              )
              .map((item) => (
                <div className="history-row" key={item.roundNumber}>
                  <span>#{item.roundNumber}</span>

                  {isAdmin && <span>
                    {item.generationMode === "manual" ? "Manual" : "Auto"}
                  </span>}

                  <strong>
                    {item.crashPoint
                      ? formatMultiplier(item.crashPoint)
                      : "Cancelled"}
                  </strong>
                </div>
              ))}
          </div>

          <div className="history-disclaimer">
            {isAdmin
              ? "Manual rounds are administrator-controlled simulations. Their crash points are not independently verifiable."
              : "Virtual credits only. No cash value. Outcomes may be configured by an administrator."}
          </div>
        </aside>
      </main>
    </div>
  );
}
