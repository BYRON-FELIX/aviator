
require("dotenv").config();

const { pool, closeDatabase } = require("./database");

async function runMigration() {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Serialize this migration.
        await client.query(
            "SELECT pg_advisory_xact_lock($1)",
            [731209]
        );

        // Add a role column to existing users.
        // Existing accounts remain regular players.
        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS
                role VARCHAR(20)
                NOT NULL DEFAULT 'player'
        `);

        // Ensure only supported roles are stored.
        // This block makes the migration repeatable.
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = 'users_role_check'
                      AND conrelid = 'users'::regclass
                ) THEN
                    ALTER TABLE users
                    ADD CONSTRAINT users_role_check
                    CHECK (
                        role IN ('player', 'admin')
                    );
                END IF;
            END
            $$
        `);

        // Index for administrative account queries.
        await client.query(`
            CREATE INDEX IF NOT EXISTS
                idx_users_role
            ON users (role)
        `);

        await client.query("COMMIT");

        console.log(
            "Migration 004 completed successfully."
        );

        console.log(
            "User roles are ready: player, admin."
        );
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {
            // Preserve the original error.
        }

        console.error(
            "Migration 004 failed:",
            error.message
        );

        process.exitCode = 1;
    } finally {
        client.release();
        await closeDatabase();
    }
}

runMigration();
