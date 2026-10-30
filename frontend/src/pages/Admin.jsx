import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Plane,
  LayoutDashboard,
  Settings,
  History,
  LogOut,
  RefreshCw,
  Save,
  Activity,
  ShieldCheck,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";

const API_URL = "http://localhost:5000";

function formatMultiplier(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}x` : "—";
}

export default function Admin({ user, token, onLogout }) {
  const navigate = useNavigate();

  const [settings, setSettings] = useState(null);
  const [mode, setMode] = useState("automatic");
  const [crashPoint, setCrashPoint] = useState("2.50");

  const [currentRound, setCurrentRound] = useState(null);
  const [audit, setAudit] = useState([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const request = useCallback(
    async (path, options = {}) => {
      const response = await fetch(`${API_URL}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body
            ? { "Content-Type": "application/json" }
            : {}),
          ...options.headers,
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || `Request failed (${response.status})`
        );
      }

      return data;
    },
    [token]
  );

  const loadDashboard = useCallback(
    async (syncForm = false) => {
      const [settingsData, roundData, auditData] = await Promise.all([
        request("/api/admin/simulation/settings"),
        request("/api/admin/simulation/round"),
        request("/api/admin/simulation/audit"),
      ]);

      setSettings(settingsData.settings);
      setCurrentRound(roundData.round);
      setAudit(auditData.history || []);

      if (syncForm) {
        setMode(settingsData.settings.mode);

        if (settingsData.settings.manualCrashPoint !== null) {
          setCrashPoint(
            Number(settingsData.settings.manualCrashPoint).toFixed(2)
          );
        }
      }
    },
    [request]
  );

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        await loadDashboard(true);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    initialize();

    const interval = setInterval(() => {
      loadDashboard(false).catch(() => {});
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadDashboard]);

  async function saveSettings(event) {
    event.preventDefault();

    setError("");
    setSuccess("");

    const parsedCrashPoint = Number(crashPoint);

    if (
      mode === "manual" &&
      (
        !Number.isFinite(parsedCrashPoint) ||
        parsedCrashPoint < 1 ||
        parsedCrashPoint > 1000000 ||
        Math.abs(
          parsedCrashPoint * 100 -
          Math.round(parsedCrashPoint * 100)
        ) > 0.000001
      )
    ) {
      setError("Enter a valid crash point with up to two decimals.");
      return;
    }

    setSaving(true);

    try {
      await request("/api/admin/simulation/settings", {
        method: "PUT",
        body: JSON.stringify({
          mode,
          ...(mode === "manual"
            ? { manualCrashPoint: parsedCrashPoint }
            : {}),
        }),
      });

      await loadDashboard(true);

      setSuccess(
        "Settings saved. The new configuration applies to future rounds."
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function logout() {
    onLogout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <Plane size={26} />
          <div>
            <strong>AVIATOR</strong>
            <span>ADMIN PANEL</span>
          </div>
        </div>

        <div className="admin-nav">
          <div className="admin-nav-item active">
            <LayoutDashboard size={18} />
            Dashboard
          </div>

          <a href="#simulation-settings" className="admin-nav-item">
            <Settings size={18} />
            Round Settings
          </a>

          <a href="#audit-history" className="admin-nav-item">
            <History size={18} />
            Audit History
          </a>

          <Link to="/" className="admin-nav-item">
            <ArrowLeft size={18} />
            View Game
          </Link>
        </div>

        <div className="admin-sidebar-footer">
          <span>{user?.username || "Administrator"}</span>

          <button type="button" onClick={logout}>
            <LogOut size={17} />
            Logout
          </button>
        </div>
      </aside>

      <main className="admin-main">
        <div className="admin-topbar">
          <div>
            <h1>Game Dashboard</h1>
            <p>Manage rounds, settings and activity</p>
          </div>

          <button
            type="button"
            className="refresh-button"
            onClick={() => {
              setError("");
              loadDashboard(false).catch((err) =>
                setError(err.message)
              );
            }}
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>

        <div className="admin-warning">
          <AlertTriangle size={20} />
          <div>
            <strong>Round configuration</strong>
            <p>
              Manually configured crash points are not provably fair.
              Changes apply to future rounds and are recorded in the audit history.
            </p>
          </div>
        </div>

        {error && <div className="admin-error">{error}</div>}
        {success && <div className="admin-success">{success}</div>}

        {loading ? (
          <div className="admin-card">Loading dashboard...</div>
        ) : (
          <>
            <div className="admin-stats">
              <div className="admin-stat-card">
                <div className="stat-icon">
                  <Settings size={20} />
                </div>
                <span>Current Mode</span>
                <strong>
                  {settings?.mode === "manual"
                    ? "Manual"
                    : "Automatic"}
                </strong>
              </div>

              <div className="admin-stat-card">
                <div className="stat-icon">
                  <Activity size={20} />
                </div>
                <span>Current Round</span>
                <strong>
                  #{currentRound?.roundNumber ?? "—"}
                </strong>
              </div>

              <div className="admin-stat-card">
                <div className="stat-icon">
                  <Plane size={20} />
                </div>
                <span>Round Status</span>
                <strong className="capitalize">
                  {currentRound?.status || "Unavailable"}
                </strong>
              </div>

              <div className="admin-stat-card">
                <div className="stat-icon">
                  <ShieldCheck size={20} />
                </div>
                <span>Currency</span>
                <strong>Virtual credits</strong>
              </div>
            </div>

            <div className="admin-grid">
              <section
                className="admin-card"
                id="simulation-settings"
              >
                <div className="admin-card-heading">
                  <h2>Crash Point Settings</h2>
                  <p>Configure how future rounds are generated.</p>
                </div>

                <form onSubmit={saveSettings}>
                  <label className="admin-field-label">
                    Generation mode
                  </label>

                  <div className="mode-options">
                    <button
                      type="button"
                      className={
                        mode === "automatic"
                          ? "mode-option selected"
                          : "mode-option"
                      }
                      onClick={() => setMode("automatic")}
                    >
                      <RefreshCw size={21} />
                      <strong>Automatic</strong>
                      <span>Algorithm-generated crash points</span>
                    </button>

                    <button
                      type="button"
                      className={
                        mode === "manual"
                          ? "mode-option selected"
                          : "mode-option"
                      }
                      onClick={() => setMode("manual")}
                    >
                      <Settings size={21} />
                      <strong>Manual</strong>
                      <span>Administrator-configured crash point</span>
                    </button>
                  </div>

                  {mode === "manual" && (
                    <div className="manual-settings">
                      <label
                        className="admin-field-label"
                        htmlFor="crashPoint"
                      >
                        Crash multiplier
                      </label>

                      <div className="crash-point-input">
                        <input
                          id="crashPoint"
                          type="number"
                          min="1"
                          max="1000000"
                          step="0.01"
                          value={crashPoint}
                          onChange={(event) =>
                            setCrashPoint(event.target.value)
                          }
                          required
                        />
                        <span>x</span>
                      </div>

                      <div className="preset-multipliers">
                        {[1.5, 2, 3, 5, 10].map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() =>
                              setCrashPoint(value.toFixed(2))
                            }
                          >
                            {value.toFixed(2)}x
                          </button>
                        ))}
                      </div>

                      <p className="admin-helper-text">
                        This value will be visible in the admin panel
                        and will determine the next manual simulation
                        round's crash point.
                      </p>
                    </div>
                  )}

                  <button
                    className="save-settings-button"
                    type="submit"
                    disabled={saving}
                  >
                    <Save size={17} />
                    {saving ? "Saving..." : "Save Settings"}
                  </button>
                </form>
              </section>

              <section className="admin-card">
                <div className="admin-card-heading">
                  <h2>Live Round Monitor</h2>
                  <p>Current game engine information</p>
                </div>

                <div className="round-monitor">
                  <div className="monitor-row">
                    <span>Round number</span>
                    <strong>
                      #{currentRound?.roundNumber ?? "—"}
                    </strong>
                  </div>

                  <div className="monitor-row">
                    <span>Status</span>
                    <strong className="capitalize">
                      {currentRound?.status || "Unavailable"}
                    </strong>
                  </div>

                  <div className="monitor-row">
                    <span>Generation mode</span>
                    <strong className="capitalize">
                      {currentRound?.generationMode || "—"}
                    </strong>
                  </div>

                  <div className="monitor-row">
                    <span>Configured crash point</span>
                    <strong>
                      {formatMultiplier(currentRound?.crashPoint)}
                    </strong>
                  </div>

                  <div className="monitor-row">
                    <span>Virtual simulation</span>
                    <strong>
                      {currentRound?.isSimulation
                        ? "Yes"
                        : "Unknown"}
                    </strong>
                  </div>
                </div>

                <div className="monitor-note">
                  Settings changes do not modify rounds that are
                  already waiting or running.
                </div>
              </section>
            </div>

            <section className="admin-card" id="audit-history">
              <div className="admin-card-heading">
                <h2>Settings Audit History</h2>
                <p>Recent administrative configuration changes</p>
              </div>

              <div className="admin-table-wrapper">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Admin ID</th>
                      <th>Previous Mode</th>
                      <th>New Mode</th>
                      <th>Crash Point</th>
                    </tr>
                  </thead>

                  <tbody>
                    {audit.length === 0 ? (
                      <tr>
                        <td colSpan="5" className="empty-table">
                          No configuration changes recorded.
                        </td>
                      </tr>
                    ) : (
                      audit.map((entry) => (
                        <tr key={entry.id}>
                          <td>
                            {new Date(
                              entry.createdAt
                            ).toLocaleString()}
                          </td>
                          <td>{entry.adminUserId ?? "—"}</td>
                          <td className="capitalize">
                            {entry.previousMode || "—"}
                          </td>
                          <td className="capitalize">
                            {entry.newMode}
                          </td>
                          <td>
                            {entry.newMode === "manual"
                              ? formatMultiplier(
                                  entry.newCrashPoint
                                )
                              : "Automatic"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
