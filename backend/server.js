
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const GameEngine = require("./gameEngine");
const GameLock = require("./gameLock");
const AuthManager = require("./authManager");
const WalletManager = require("./walletManager");
const BetManager = require("./betManager");
const SimulationManager = require("./simulationManager");
const PaymentManager = require("./paymentManager");
const WithdrawalManager = require("./withdrawalManager");

const { query, closeDatabase } = require("./database");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const game = new GameEngine();
const gameLock = new GameLock();
const auth = new AuthManager();
const wallets = new WalletManager();
const bets = new BetManager(game);
game.settleAutoCashouts = () => bets.settleAutoCashouts();
const simulation = new SimulationManager();
const payments = new PaymentManager();
const withdrawals = new WithdrawalManager();

const PORT = Number(process.env.PORT) || 5000;

let shuttingDown = false;
let serverStarted = false;

app.use(cors());
app.use(express.json({ limit: "20kb" }));

// =====================================
// HELPERS
// =====================================

function publicRound(round) {
    if (!round) return null;

    const crashed = round.status === "crashed";
    return {
        roundNumber: round.roundNumber,
        status: round.status,
        multiplier: round.multiplier,
        countdown: round.countdown,
        crashPoint: crashed ? round.crashPoint : null,
        isSimulation: true
    };
}

function broadcast(payload) {
    const message = JSON.stringify(payload);

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function getToken(req) {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    return scheme === "Bearer" && token
        ? token
        : null;
}

function requireAuth(req, res, next) {
    const token = getToken(req);

    if (!token) {
        return res.status(401).json({
            error: "Authentication required"
        });
    }

    try {
        req.auth = auth.verifyToken(token);
        next();
    } catch (error) {
        return res.status(401).json({
            error: "Invalid or expired authentication token"
        });
    }
}

function asyncHandler(handler) {
    return (req, res, next) => {
        Promise.resolve(
            handler(req, res, next)
        ).catch(next);
    };
}

async function requireAdmin(req, res, next) {
    try {
        const userId = req.auth?.sub;

        if (!userId) {
            return res.status(401).json({
                error: "Authentication required"
            });
        }

        const result = await query(
            `SELECT id, role
             FROM users
             WHERE id = $1`,
            [userId]
        );

        const user = result.rows[0];

        if (!user || user.role !== "admin") {
            return res.status(403).json({
                error: "Administrator access required"
            });
        }

        req.adminId = String(user.id);

        next();
    } catch (error) {
        next(error);
    }
}

// =====================================
// STATUS
// =====================================

app.get("/", (req, res) => {
    res.json({
        name: "Aviator Game Backend",
        status: serverStarted ? "running" : "starting",
        database: "PostgreSQL",
        mode: "virtual-credit simulation",
        gameLock: gameLock.isLocked()
    });
});

app.get(
    "/api/health",
    asyncHandler(async (req, res) => {
        await query("SELECT 1");

        res.json({
            status: "ok",
            database: "connected",
            gameLock: gameLock.isLocked()
        });
    })
);

// =====================================
// AUTHENTICATION
// =====================================

app.post(
    "/api/auth/register",
    asyncHandler(async (req, res) => {
        const user = await auth.register(req.body || {});

        await wallets.createWallet(user.id);

        res.status(201).json({
            message: "Registration successful",
            user
        });
    })
);

app.post(
    "/api/auth/login",
    asyncHandler(async (req, res) => {
        const result = await auth.login(req.body || {});

        res.json({
            message: "Login successful",
            ...result
        });
    })
);

app.get(
    "/api/auth/me",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await query(
            `SELECT id, username, role, created_at
             FROM users
             WHERE id = $1`,
            [req.auth.sub]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                error: "User not found"
            });
        }

        const user = result.rows[0];

        res.json({
            user: {
                id: String(user.id),
                username: user.username,
                role: user.role,
                createdAt: user.created_at
            }
        });
    })
);

// =====================================
// GAME
// =====================================

app.get("/api/game", (req, res) => {
    res.json({
        round: publicRound(game.getCurrentRound())
    });
});

app.get("/api/game/history", (req, res) => {
    res.json({
        history: game.getRoundHistory().map(publicRound)
    });
});

app.get(
    "/api/game/verify/:roundNumber",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const roundNumber = Number(req.params.roundNumber);

        if (
            !Number.isSafeInteger(roundNumber) ||
            roundNumber < 1
        ) {
            return res.status(400).json({
                error: "Invalid round number"
            });
        }

        const result = await query(
            `SELECT *
             FROM game_rounds
             WHERE round_number = $1`,
            [roundNumber]
        );

        const row = result.rows[0];

        if (!row || row.status !== "crashed") {
            return res.status(404).json({
                error: "Completed round not found"
            });
        }

        if (row.generation_mode === "manual") {
            return res.json({
                roundNumber,
                generationMode: "manual",
                verifiable: false,
                reason:
                    "Crash point was configured by an administrator for a virtual-credit simulation."
            });
        }

        const verification = game.verifyRound({
            serverSeed: row.server_seed,
            serverSeedHash: row.server_seed_hash,
            crashPoint: Number(row.crash_point),
            generationMode: "automatic"
        });

        res.json({
            roundNumber,
            generationMode: "automatic",
            verifiable: true,
            verification
        });
    })
);

// =====================================
// ADMIN SIMULATION CONTROLS
// =====================================

app.get(
    "/api/admin/simulation/history",
    requireAuth,
    requireAdmin,
    (req, res) => {
        res.json({ history: game.getRoundHistory().map(round => ({
            ...publicRound(round),
            generationMode: round.generationMode || "automatic"
        })) });
    }
);

// View current simulation configuration.
app.get(
    "/api/admin/simulation/settings",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const settings = await simulation.getSettings();

        res.json({ settings });
    })
);

// Switch between automatic and manual mode.
app.put(
    "/api/admin/simulation/settings",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const { mode, manualCrashPoint } = req.body || {};

        if (
            mode !== "automatic" &&
            mode !== "manual"
        ) {
            return res.status(400).json({
                error:
                    "Mode must be automatic or manual"
            });
        }

        if (
            mode === "manual" &&
            (
                typeof manualCrashPoint !== "number" ||
                !Number.isFinite(manualCrashPoint) ||
                manualCrashPoint < 1 ||
                manualCrashPoint > 1000000
            )
        ) {
            return res.status(400).json({
                error:
                    "Provide a valid manual crash point between 1.00 and 1000000.00"
            });
        }

        const settings = await simulation.updateSettings({
            adminUserId: req.adminId,
            mode,
            manualCrashPoint:
                mode === "manual"
                    ? manualCrashPoint
                    : null
        });

        res.json({
            message:
                "Simulation settings updated. Changes apply to future rounds.",
            settings
        });
    })
);

// View administrative change history.
app.get(
    "/api/admin/simulation/audit",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const history = await simulation.getAuditHistory(
            req.query.limit
        );

        res.json({ history });
    })
);

// View the current round's simulation metadata.
app.get(
    "/api/admin/simulation/round",
    requireAuth,
    requireAdmin,
    (req, res) => {
        const round = game.getCurrentRound();

        res.json({
            round: round
                ? {
                    roundNumber: round.roundNumber,
                    status: round.status,
                    generationMode: round.generationMode,
                    configuredBy: round.configuredBy,
                    crashPoint: round.crashPoint,
                    isSimulation: round.isSimulation
                }
                : null
        });
    }
);

// =====================================
// WALLET READ ENDPOINTS
// =====================================

app.get("/api/wallet/cash", requireAuth, asyncHandler(async (req, res) => {
    const [cash, payouts] = await Promise.all([payments.summary(req.auth.sub), withdrawals.summary(req.auth.sub)]);
    res.json({ ...cash, ...payouts });
}));

app.post("/api/payments/withdrawals", requireAuth, asyncHandler(async (req, res) => {
    const user = await auth.getUser(req.auth.sub);
    if (!user) return res.status(401).json({ error: "Account not found" });
    await auth.login({ username: user.username, password: req.body?.password });
    res.status(202).json({ withdrawal: await withdrawals.initiate(req.auth.sub, req.body) });
}));

app.post("/api/payments/payhero/withdrawal-callback/:id/:token", asyncHandler(async (req, res) => {
    const accepted = await withdrawals.callback(req.params.id, req.params.token, req.body);
    res.status(accepted ? 200 : 403).json({ accepted });
}));

app.post("/api/payments/deposits", requireAuth, asyncHandler(async (req, res) => {
    res.status(202).json({ deposit: await payments.initiate(req.auth.sub, req.body) });
}));

app.post("/api/payments/payhero/callback/:id/:token", asyncHandler(async (req, res) => {
    const accepted = await payments.callback(req.params.id, req.params.token, req.body);
    res.status(accepted ? 200 : 403).json({ accepted });
}));

app.get(
    "/api/wallet/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
        if (String(req.auth.sub) !== req.params.userId) {
            return res.status(403).json({
                error: "Access denied"
            });
        }

        const wallet = await wallets.getWallet(req.auth.sub);

        if (!wallet) {
            return res.status(404).json({
                error: "Wallet not found"
            });
        }

        res.json({ wallet });
    })
);

app.get(
    "/api/wallet/:userId/transactions",
    requireAuth,
    asyncHandler(async (req, res) => {
        if (String(req.auth.sub) !== req.params.userId) {
            return res.status(403).json({
                error: "Access denied"
            });
        }

        res.json({
            transactions:
                await wallets.getTransactions(req.auth.sub)
        });
    })
);

// =====================================
// BETTING READ ENDPOINTS
// =====================================

app.get(
    "/api/bets/:betId",
    requireAuth,
    asyncHandler(async (req, res) => {
        const bet = await bets.getBet(req.params.betId);

        if (!bet) {
            return res.status(404).json({
                error: "Bet not found"
            });
        }

        if (
            String(bet.userId) !==
            String(req.auth.sub)
        ) {
            return res.status(403).json({
                error: "Access denied"
            });
        }

        res.json({ bet });
    })
);

app.get(
    "/api/users/:userId/bets",
    requireAuth,
    asyncHandler(async (req, res) => {
        if (String(req.auth.sub) !== req.params.userId) {
            return res.status(403).json({
                error: "Access denied"
            });
        }

        res.json({
            bets: await bets.getUserBets(req.auth.sub)
        });
    })
);

// =====================================
// VIRTUAL-CREDIT BETTING
// =====================================

app.post(
    "/api/wallet/deposit",
    requireAuth,
    asyncHandler(async (req, res) => {
        res.status(202).json({ deposit: await payments.initiate(req.auth.sub, req.body) });
    })
);

app.post(
    "/api/bets",
    requireAuth,
    asyncHandler(async (req, res) => {
        const bet = await bets.placeBet({ ...req.body, userId: req.auth.sub });
        res.json({ bet });
    })
);

app.post(
    "/api/bets/cashout",
    requireAuth,
    asyncHandler(async (req, res) => {
        const bet = await bets.cashOut({ betId: req.body?.betId, userId: req.auth.sub });
        res.json({ bet, wallet: { balance: bet.walletBalance } });
    })
);

// One recorded, non-purchasable credit grant per account.
app.post("/api/wallet/claim", requireAuth, asyncHandler(async (req, res) => {
    await wallets.createWallet(req.auth.sub);
    let granted = true;
    try {
        await wallets.deposit(req.auth.sub, 1000, {
            type: "adjustment",
            reference: `virtual:starter:${req.auth.sub}`,
            metadata: { virtualCredits: true }
        });
    } catch (error) {
        if (error.code !== "23505") throw error;
        granted = false;
    }
    res.json({ granted, wallet: await wallets.getWallet(req.auth.sub) });
}));

// =====================================
// WEBSOCKETS
// =====================================

wss.on("connection", socket => {
    socket.send(JSON.stringify({
        type: "game_state",
        round: publicRound(game.getCurrentRound())
    }));
});

// =====================================
// ERROR HANDLING
// =====================================

app.use((error, req, res, next) => {
    console.error(
        "Request error:",
        error.message
    );

    if (error.type === "entity.parse.failed") {
        return res.status(400).json({
            error: "Invalid JSON request"
        });
    }
    if (error.message === "M-Pesa deposits are not configured yet") {
        return res.status(503).json({ error: error.message });
    }
    if (error.message === "M-Pesa withdrawals are not configured yet") {
        return res.status(503).json({ error: error.message });
    }
    if (/^(Withdrawal |Invalid withdrawal|Insufficient cash balance|Please wait for your previous withdrawal)/.test(error.message)) {
        return res.status(400).json({ error: error.message });
    }
    if (/^(Deposit |Invalid deposit|Enter a valid Kenyan|Please wait one minute|Invalid payment confirmation)/.test(error.message)) {
        return res.status(400).json({ error: error.message });
    }

    if (/^(Invalid bet|Invalid auto|Bet amount|Betting is closed|Maximum two|Insufficient balance|Cash-out|Round is no longer|Aircraft already|Bet already|Auto cash-out|Wallet limit)/.test(error.message)) {
        return res.status(400).json({ error: error.message });
    }
    if (error.message === "Bet not found") return res.status(404).json({ error: "Bet not found" });

    if (error.message === "Invalid username or password") {
        return res.status(401).json({ error: error.message });
    }

    if (error.message === "Username is already registered") {
        return res.status(409).json({ error: error.message });
    }

    if (
        error.message.startsWith("Username must contain") ||
        error.message.startsWith("Password must contain") ||
        error.message === "Username and password are required"
    ) {
        return res.status(400).json({ error: error.message });
    }

    if (
        error.message.startsWith("Crash point") ||
        error.message.startsWith("Invalid simulation") ||
        error.message.startsWith("Administrator identity")
    ) {
        return res.status(400).json({
            error: error.message
        });
    }

    res.status(500).json({
        error: "Internal server error"
    });
});

// =====================================
// CONTROLLED SHUTDOWN
// =====================================

async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;

    console.log(`Shutting down: ${signal}`);

    game.stopAutomaticGame();

    for (const client of wss.clients) {
        client.terminate();
    }

    try {
        await new Promise(resolve => {
            wss.close(() => resolve());
        });

        if (server.listening) {
            await new Promise(resolve => {
                server.close(() => resolve());
            });
        }

        await gameLock.release();
        await closeDatabase();

        console.log("Shutdown complete.");
        process.exit(0);
    } catch (error) {
        console.error(
            "Shutdown error:",
            error.message
        );

        process.exit(1);
    }
}

process.on("SIGINT", () => {
    shutdown("SIGINT");
});

process.on("SIGTERM", () => {
    shutdown("SIGTERM");
});

// =====================================
// STARTUP
// =====================================

async function startServer() {
    try {
        await query("SELECT 1");

        console.log("PostgreSQL connected.");

        await gameLock.acquire();

        await game.initialize();

        await game.startAutomaticGame(event => {
            broadcast({
                type: "game_update",
                event: typeof event === "string" ? event : event.type,
                round: publicRound(game.getCurrentRound())
            });
        });

        await new Promise((resolve, reject) => {
            server.once("error", reject);

            server.listen(PORT, () => {
                server.removeListener("error", reject);
                resolve();
            });
        });

        serverStarted = true;
        // Replay authenticated callbacks that arrived before the initiation response.
        const paymentTimer = setInterval(() => {
            payments.processStoredEvents().catch(error => console.error("Payment confirmation processing:", error.message));
            withdrawals.processStoredEvents().catch(error => console.error("Withdrawal confirmation processing:", error.message));
        }, 30000);
        paymentTimer.unref();

        console.log(
            `Aviator backend running on http://localhost:${PORT}`
        );

        console.log(
            "Admin simulation API enabled."
        );
    } catch (error) {
        console.error(
            "Server startup failed:",
            error.message
        );

        game.stopAutomaticGame();

        try {
            await gameLock.release();
            await closeDatabase();
        } catch (cleanupError) {
            console.error(
                "Startup cleanup failed:",
                cleanupError.message
            );
        }

        process.exit(1);
    }
}

startServer();
