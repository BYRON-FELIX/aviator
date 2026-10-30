
const crypto = require("crypto");
const { pool } = require("./database");

class RoundManager {
    formatRound(row) {
        if (!row) return null;

        return {
            id: String(row.id),
            roundNumber: Number(row.round_number),
            serverSeedHash: row.server_seed_hash,
            serverSeed:
                row.status === "crashed"
                    ? row.server_seed
                    : null,
            crashPoint:
                row.status === "crashed" &&
                row.crash_point !== null
                    ? Number(row.crash_point)
                    : null,
            status: row.status,
            generationMode:
                row.generation_mode || "automatic",
            configuredBy:
                row.configured_by === null
                    ? null
                    : String(row.configured_by),
            isSimulation: row.is_simulation,
            verifiable:
                row.status === "crashed" &&
                row.generation_mode === "automatic",
            startedAt: row.started_at,
            crashedAt: row.crashed_at,
            cancelledAt: row.cancelled_at,
            cancellationReason: row.cancellation_reason,
            createdAt: row.created_at
        };
    }

    async createRound({
        serverSeedHash,
        generationMode = "automatic",
        configuredBy = null
    }) {
        const client = await pool.connect();

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
                    configuredBy
                ]
            );

            await client.query("COMMIT");

            return this.formatRound(result.rows[0]);
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async startRound(roundNumber) {
        const result = await pool.query(
            `UPDATE game_rounds
             SET status = 'running',
                 started_at = clock_timestamp()
             WHERE round_number = $1
               AND status = 'waiting'
             RETURNING *`,
            [roundNumber]
        );

        if (!result.rows.length) {
            throw new Error(
                "Round cannot be started"
            );
        }

        return this.formatRound(result.rows[0]);
    }

    async crashRound({
        roundNumber,
        serverSeed,
        crashPoint
    }) {
        if (
            typeof serverSeed !== "string" ||
            !/^[a-f0-9]{64}$/i.test(serverSeed)
        ) {
            throw new Error("Invalid server seed");
        }

        const validatedCrashPoint = Number(crashPoint);

        if (
            !Number.isFinite(validatedCrashPoint) ||
            validatedCrashPoint < 1 ||
            validatedCrashPoint > 1000000
        ) {
            throw new Error("Invalid crash point");
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const roundResult = await client.query(
                `SELECT *
                 FROM game_rounds
                 WHERE round_number = $1
                 FOR UPDATE`,
                [roundNumber]
            );

            const round = roundResult.rows[0];

            if (!round || round.status !== "running") {
                throw new Error(
                    "Round is not running"
                );
            }

            const actualHash = crypto
                .createHash("sha256")
                .update(serverSeed)
                .digest("hex");

            if (actualHash !== round.server_seed_hash) {
                throw new Error(
                    "Server seed hash mismatch"
                );
            }

            // Automatic rounds use the generated crash point.
            // Manual rounds use the admin-configured value.
            // The mode is permanently recorded in the database.

            const updated = await client.query(
                `UPDATE game_rounds
                 SET status = 'crashed',
                     server_seed = $2,
                     crash_point = $3,
                     crashed_at = clock_timestamp()
                 WHERE round_number = $1
                   AND status = 'running'
                 RETURNING *`,
                [
                    roundNumber,
                    serverSeed,
                    validatedCrashPoint.toFixed(2)
                ]
            );

            await client.query(
                `UPDATE bets
                 SET status = 'lost',
                     profit = -amount
                 WHERE round_number = $1
                   AND status = 'active'`,
                [roundNumber]
            );

            await client.query("COMMIT");

            return this.formatRound(updated.rows[0]);
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async getRound(roundNumber) {
        const result = await pool.query(
            `SELECT *
             FROM game_rounds
             WHERE round_number = $1`,
            [roundNumber]
        );

        return this.formatRound(result.rows[0]);
    }

    async getCurrentRound() {
        const result = await pool.query(
            `SELECT *
             FROM game_rounds
             WHERE status IN ('waiting', 'running')
             ORDER BY round_number DESC
             LIMIT 1`
        );

        return this.formatRound(result.rows[0]);
    }

    async getHistory(limit = 20) {
        const safeLimit = Math.min(
            100,
            Math.max(1, Math.trunc(Number(limit) || 20))
        );

        const result = await pool.query(
            `SELECT *
             FROM game_rounds
             WHERE status IN ('crashed', 'cancelled')
             ORDER BY round_number DESC
             LIMIT $1`,
            [safeLimit]
        );

        return result.rows.map(row =>
            this.formatRound(row)
        );
    }
}

module.exports = RoundManager;
