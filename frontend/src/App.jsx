import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";

import Game from "./pages/Game";
import Admin from "./pages/Admin";
import Login from "./pages/Login";
import Wallet from "./pages/Wallet";

import "./App.css";

const API_URL = "http://localhost:5000";

function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem("aviator_token") || ""
  );

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));

  useEffect(() => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function loadUser() {
      setLoading(true);

      try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error("Session expired");
        }

        const data = await response.json();

        if (!cancelled) {
          setUser(data.user);
        }
      } catch {
        if (!cancelled) {
          sessionStorage.removeItem("aviator_token");
          setToken("");
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadUser();

    return () => {
      cancelled = true;
    };
  }, [token]);

  function handleLogin(newToken, loggedInUser) {
    sessionStorage.setItem("aviator_token", newToken);
    setToken(newToken);
    setUser(loggedInUser);
  }

  function handleLogout() {
    sessionStorage.removeItem("aviator_token");
    setToken("");
    setUser(null);
  }

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>Loading Aviator...</p>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/wallet" element={user ? <Wallet token={token} /> : <Navigate to="/login" replace />} />
        <Route
          path="/"
          element={
            <Game
              user={user}
              token={token}
              onLogout={handleLogout}
            />
          }
        />

        <Route
          path="/login"
          element={
            user ? (
              <Navigate to="/" replace />
            ) : (
              <Login onLogin={handleLogin} />
            )
          }
        />

        <Route
          path="/admin"
          element={
            !user ? (
              <Navigate to="/login" replace />
            ) : user.role !== "admin" ? (
              <Navigate to="/" replace />
            ) : (
              <Admin
                user={user}
                token={token}
                onLogout={handleLogout}
              />
            )
          }
        />

        <Route
          path="*"
          element={<Navigate to="/" replace />}
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
