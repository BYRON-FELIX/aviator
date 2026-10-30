
require("dotenv").config();

const { pool } = require("./database");

async function migrate() {
    const client = await pool.connect();

    try {
        console.log("Starting database migration 002...");

        await client.query("BEGIN");

        // Prevent simultaneous executions.
        await client.query(
            "SELECT pg_advisory_xact_lock(731205)"
        );

        // Allow cancelled game rounds.
        await client.query(`
            ALTER TABLE game_rounds
            DROP CONSTRAINT IF EXISTS game_rounds_status_check
        `);

        await client.query(`
            ALTER TABLE game_rounds
            ADD CONSTRAINT game_rounds_status_check
            CHECK (
                status IN (
                    'waiting',
                    'running',
                    'crashed',
                    'cancelled'
                )
            )
        `);

        // Allow refunded bets.
        await client.query(`
            ALTER TABLE bets
            DROP CONSTRAINT IF EXISTS bets_status_check
        `);

        await client.query(`
            ALTER TABLE bets
            ADD CONSTRAINT bets_status_check
            CHECK (
                status IN (
                    'active',
                    'cashed_out',
                    'lost',
                    'refunded'
                )
            )
        `);

        // Add cancellation fields.
        await client.query(`
            ALTER TABLE game_rounds
            ADD COLUMN IF NOT EXISTS
            cancelled_at TIMESTAMPTZ
        `);

        await client.query(`
            ALTER TABLE game_rounds
            ADD COLUMN IF NOT EXISTS
            cancellation_reason TEXT
        `);

        // Add refund timestamp.
        await client.query(`
            ALTER TABLE bets
            ADD COLUMN IF NOT EXISTS
            refunded_at TIMESTAMPTZ
        `);

        // Make this constraint idempotent.
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = 'cancelled_round_no_crash'
                      AND conrelid = 'game_rounds'::regclass
                ) THEN
                    ALTER TABLE game_rounds
                    ADD CONSTRAINT cancelled_round_no_crash
                    CHECK (
                        status <> 'cancelled'
                        OR crash_point IS NULL
                    );
                END IF;
            END
            $$;
        `);

        await client.query("COMMIT");

        console.log(
            "Migration 002 completed successfully."
        );
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            console.error(
                "Rollback failed:",
                rollbackError.message
            );
        }

        console.error(
            "Migration 002 failed:",
            error.message
        );

        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
