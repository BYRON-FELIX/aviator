import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Plane, Eye, EyeOff, ArrowLeft } from "lucide-react";

const API_URL = "http://localhost:5000";

export default function Login({ onLogin }) {
  const navigate = useNavigate();

  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function submit(event) {
    event.preventDefault();

    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch(
        `${API_URL}/api/auth/${mode === "login" ? "login" : "register"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: username.trim(),
            password,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.message || "Request failed.");
      }

      if (mode === "register") {
        setMode("login");
        setPassword("");
        setError("");
        setSuccess("Account created. Log in with your username and password.");
        return;
      }

      const token = data.token || data.accessToken;

      if (!token) {
        throw new Error("Login response did not contain a token.");
      }

      const meResponse = await fetch(`${API_URL}/api/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!meResponse.ok) {
        throw new Error("Could not load your account.");
      }

      const meData = await meResponse.json();
      const user = meData.user;

      if (!user) {
        throw new Error("Account information is missing.");
      }

      onLogin(token, user);

      navigate(user.role === "admin" ? "/admin" : "/", {
        replace: true,
      });
    } catch (err) {
      setError(err instanceof TypeError
        ? "Cannot connect to the server. Make sure the backend is running on port 5000, then try again."
        : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link to="/" className="back-link">
          <ArrowLeft size={16} />
          Back to game
        </Link>

        <div className="auth-logo">
          <Plane size={28} />
        </div>

        <h1>AVIATOR</h1>
        <p className="auth-subtitle">
          Your next flight starts here
        </p>

        <div className="auth-tabs">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => {
              setMode("login");
              setError("");
            }}
          >
            Login
          </button>

          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => {
              setMode("register");
              setError("");
            }}
          >
            Register
          </button>
        </div>

        <form onSubmit={submit} className="auth-form">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            placeholder="Enter username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />

          <label htmlFor="password">Password</label>

          <div className="password-field">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete={
                mode === "register"
                  ? "new-password"
                  : "current-password"
              }
              placeholder="Enter password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />

            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={
                showPassword ? "Hide password" : "Show password"
              }
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          {error && <div className="auth-error">{error}</div>}
          {success && <div className="admin-success" role="status">{success}</div>}

          <button
            type="submit"
            className="auth-submit"
            disabled={loading}
          >
            {loading
              ? "Please wait..."
              : mode === "login"
              ? "Login"
              : "Create account"}
          </button>
        </form>

        <p className="auth-note">
          Virtual credits only. No cash value.
        </p>
      </div>
    </div>
  );
}
