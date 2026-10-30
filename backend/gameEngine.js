
const crypto = require("crypto");

const ProvablyFair = require("./provablyFair");
const RoundManager = require("./roundManager");
const SimulationManager = require("./simulationManager");

const { pool } = require("./database");

class GameEngine {
    constructor() {
        this.fairness = new ProvablyFair();
        this.roundManager = new RoundManager();
        this.simulationManager = new SimulationManager();

        this.currentRound = null;
        this.roundHistory = [];

        this.isRunning = false;
        this.initialized = false;
        this.transitioning = false;

        this.timer = null;
        this.nextRoundTimer = null;

        this.waitingDuration = 10000;
        this.crashPauseDuration = 3000;

        this.onUpdate = null;
    }

    async initialize() {
        if (this.initialized) return;

        await this.recoverInterruptedRounds();

        this.roundHistory =
            await this.roundManager.getHistory(20);

        this.initialized = true;

        console.log("Game engine initialized.");
    }

    async recoverInterruptedRounds() {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            await client.query(
                "SELECT pg_advisory_xact_lock($1)",
                [731206]
            );

            const rounds = await client.query(
                `SELECT round_number
                 FROM game_rounds
                 WHERE status IN ('waiting', 'running')
                 ORDER BY round_number
                 FOR UPDATE`
            );

            for (const round of rounds.rows) {
                const roundNumber = round.round_number;

                const activeBets = await client.query(
                    `SELECT id, user_id, amount
                     FROM bets
                     WHERE round_number = $1
                       AND status = 'active'
                     ORDER BY id
                     FOR UPDATE`,
                    [roundNumber]
                );

                for (const bet of activeBets.rows) {
                    const walletResult = await client.query(
                        `SELECT balance
                         FROM wallets
                         WHERE user_id = $1
                         FOR UPDATE`,
                        [bet.user_id]
                    );

                    if (!walletResult.rows.length) {
                        throw new Error(
                            `Wallet missing for bet ${bet.id}`
                        );
                    }

                    const before = Math.round(
                        Number(walletResult.rows[0].balance) * 100
                    );

                    const refund = Math.round(
                        Number(bet.amount) * 100
                    );

                    const after = before + refund;

                    if (
                        !Number.isSafeInteger(after) ||
                        after > 99999999999999
                    ) {
                        throw new Error(
                            "Recovery wallet balance overflow"
                        );
                    }

                    await client.query(
                        `UPDATE wallets
                         SET balance = $2,
                             updated_at = NOW()
                         WHERE user_id = $1`,
                        [
                            bet.user_id,
                            (after / 100).toFixed(2)
                        ]
                    );

                    await client.query(
                        `INSERT INTO transactions (
                            user_id,
                            type,
                            amount,
                            balance_before,
                            balance_after,
                            reference,
                            metadata
                        )
                        VALUES (
                            $1, 'refund', $2, $3, $4, $5, $6
                        )`,
                        [
                            bet.user_id,
                            (refund / 100).toFixed(2),
                            (before / 100).toFixed(2),
                            (after / 100).toFixed(2),
                            `bet:${bet.id}:restart-refund`,
                            JSON.stringify({
                                betId: String(bet.id),
                                roundNumber,
                                reason: "server_restart"
                            })
                        ]
                    );

                    await client.query(
                        `UPDATE bets
                         SET status = 'refunded',
                             refunded_at = NOW(),
                             profit = 0
                         WHERE id = $1`,
                        [bet.id]
                    );
                }

                await client.query(
                    `UPDATE game_rounds
                     SET status = 'cancelled',
                         crash_point = NULL,
                         cancelled_at = NOW(),
                         cancellation_reason = 'server_restart'
                     WHERE round_number = $1`,
                    [roundNumber]
                );
            }

            await client.query("COMMIT");

            if (rounds.rows.length) {
                console.log(
                    `Recovered ${rounds.rows.length} interrupted rounds.`
                );
            }
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    emit(type) {
        if (typeof this.onUpdate === "function") {
            try {
                this.onUpdate({
                    type,
                    round: this.getCurrentRound()
                });
            } catch (error) {
                console.error(
                    "Game update callback failed:",
                    error.message
                );
            }
        }
    }

    getCurrentRound() {
        if (!this.currentRound) return null;

        return { ...this.currentRound };
    }

    getRoundHistory() {
        return [...this.roundHistory];
    }

    verifyRound(round) {
        if (round.generationMode === "manual") {
            return {
                valid: false,
                verifiable: false,
                reason:
                    "This simulation round used an administrator-configured crash point."
            };
        }

        return this.fairness.verifyRound(
            round.serverSeed,
            round.serverSeedHash,
            Number(round.crashPoint)
        );
    }

    async createRound() {
        const configuration =
            await this.simulationManager.getRoundConfiguration();

        const generationMode = configuration.mode;

        let serverSeed;
        let serverSeedHash;
        let crashPoint;

        if (generationMode === "manual") {
            crashPoint = Number(configuration.crashPoint);

            // Manual rounds still receive a unique seed
            // for round identification, but the seed
            // does NOT determine their crash point.
            serverSeed = crypto.randomBytes(32).toString("hex");

            serverSeedHash =
                this.fairness.createHash(serverSeed);
        } else {
            serverSeed =
                this.fairness.generateServerSeed();

            serverSeedHash =
                this.fairness.createHash(serverSeed);

            crashPoint =
                this.fairness.calculateCrashPoint(serverSeed);
        }

        if (
            !Number.isFinite(crashPoint) ||
            crashPoint < 1 ||
            crashPoint > 1000000
        ) {
            throw new Error("Invalid crash point");
        }

        // Create the round and its simulation metadata
        // in the same database transaction.
        const client = await pool.connect();

        let saved;

        try {
            await client.query("BEGIN");

            await client.query(
                "SELECT pg_advisory_xact_lock($1)",
                [731204]
            );

            const result = await client.query(
                `INSERT INTO game_rounds (
                    round_number,
                    server_seed_hash,
                    status,
                    generation_mode,
                    configured_by,
                    is_simulation
                )
                SELECT
                    COALESCE(MAX(round_number), 0) + 1,
                    $1,
                    'waiting',
                    $2,
                    $3,
                    TRUE
                FROM game_rounds
                RETURNING *`,
                [
                    serverSeedHash,
                    generationMode,
                    configuration.configuredBy
                ]
            );

            saved = result.rows[0];

            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        this.currentRound = {
            roundNumber: Number(saved.round_number),
            serverSeed,
            serverSeedHash,
            crashPoint,
            generationMode,
            configuredBy: configuration.configuredBy,
            isSimulation: true,
            status: "waiting",
            multiplier: 1,
            countdown: Math.ceil(
                this.waitingDuration / 1000
            ),
            startedAt: null,
            crashedAt: null
        };

        this.emit("waiting");

        return this.getCurrentRound();
    }

    async startRound() {
        const round = this.currentRound;

        if (!round || round.status !== "waiting") {
            throw new Error("Round is not waiting");
        }

        await this.roundManager.startRound(
            round.roundNumber
        );

        const result = await pool.query(
            `SELECT status, started_at
             FROM game_rounds
             WHERE round_number = $1`,
            [round.roundNumber]
        );

        const saved = result.rows[0];

        if (
            !saved ||
            saved.status !== "running" ||
            !saved.started_at
        ) {
            throw new Error(
                "Round start not confirmed by database"
            );
        }

        round.startedAt =
            new Date(saved.started_at).getTime();

        if (!Number.isFinite(round.startedAt)) {
            throw new Error("Invalid start timestamp");
        }

        round.status = "running";
        round.countdown = 0;
        round.multiplier = 1;

        this.emit("started");

        return this.getCurrentRound();
    }

    calculateMultiplier(startedAt, timestamp = Date.now()) {
        const elapsed = Math.max(
            0,
            timestamp - startedAt
        );

        return Math.max(
            1,
            Math.floor(
                Math.exp(elapsed / 10000) * 100
            ) / 100
        );
    }

    async getDatabaseTime() {
        const result = await pool.query(
            "SELECT clock_timestamp() AS current_time"
        );

        return new Date(
            result.rows[0].current_time
        ).getTime();
    }

    async crashRound() {
        const round = this.currentRound;

        if (!round || round.status !== "running") {
            return;
        }

        if (this.transitioning) return;

        this.transitioning = true;

        try {
            await this.settleAutoCashouts?.();
            await this.roundManager.crashRound({
                roundNumber: round.roundNumber,
                serverSeed: round.serverSeed,
                crashPoint: round.crashPoint
            });

            round.status = "crashed";
            round.multiplier = round.crashPoint;
            round.crashedAt = Date.now();

            this.roundHistory =
                await this.roundManager.getHistory(20);

            this.emit("crashed");
        } finally {
            this.transitioning = false;
        }
    }

    async startRunningLoop() {
        if (!this.isRunning) return;

        const tick = async () => {
            if (!this.isRunning) return;

            const round = this.currentRound;

            if (!round || round.status !== "running") {
                return;
            }

            try {
                const databaseTime =
                    await this.getDatabaseTime();

                if (
                    !this.isRunning ||
                    this.currentRound !== round ||
                    round.status !== "running"
                ) {
                    return;
                }

                const multiplier =
                    this.calculateMultiplier(
                        round.startedAt,
                        databaseTime
                    );

                await this.settleAutoCashouts?.();
                if (multiplier >= round.crashPoint) {
                    await this.crashRound();

                    if (this.isRunning) {
                        this.nextRoundTimer = setTimeout(
                            () => {
                                this.startNextRound().catch(
                                    error => this.handleError(error)
                                );
                            },
                            this.crashPauseDuration
                        );
                    }

                    return;
                }

                round.multiplier = multiplier;
                this.emit("running");

                this.timer = setTimeout(tick, 100);
            } catch (error) {
                this.handleError(error);
            }
        };

        await tick();
    }

    async startNextRound() {
        if (!this.isRunning || this.transitioning) {
            return;
        }

        if (
            this.currentRound &&
            ["waiting", "running"].includes(
                this.currentRound.status
            )
        ) {
            throw new Error(
                "A round is already active"
            );
        }

        await this.createRound();

        const round = this.currentRound;
        const countdownStart = performance.now();

        const waitTick = async () => {
            if (
                !this.isRunning ||
                this.currentRound !== round ||
                round.status !== "waiting"
            ) {
                return;
            }

            const elapsed =
                performance.now() - countdownStart;

            const remaining = Math.max(
                0,
                this.waitingDuration - elapsed
            );

            round.countdown =
                Math.ceil(remaining / 1000);

            if (remaining <= 0) {
                try {
                    await this.startRound();

                    if (this.isRunning) {
                        await this.startRunningLoop();
                    }
                } catch (error) {
                    this.handleError(error);
                }

                return;
            }

            this.emit("waiting");

            this.timer = setTimeout(
                waitTick,
                Math.min(100, remaining)
            );
        };

        await waitTick();
    }

    async startAutomaticGame(onUpdate) {
        if (this.isRunning) return;

        await this.initialize();

        this.onUpdate = onUpdate;
        this.isRunning = true;

        try {
            await this.startNextRound();
        } catch (error) {
            this.handleError(error);
            throw error;
        }
    }

    stopAutomaticGame() {
        this.isRunning = false;

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.nextRoundTimer) {
            clearTimeout(this.nextRoundTimer);
            this.nextRoundTimer = null;
        }
    }

    handleError(error) {
        console.error(
            "Game engine error:",
            error.message
        );

        this.stopAutomaticGame();
    }
}

module.exports = GameEngine;
