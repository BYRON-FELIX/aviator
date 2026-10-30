require("dotenv").config();

const { pool, closeDatabase } = require("./database");

async function runMigration() {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Prevent two migration processes from
        // modifying the schema simultaneously.
        await client.query(
            "SELECT pg_advisory_xact_lock($1)",
            [731208]
        );

        // =====================================
        // ADMIN SIMULATION SETTINGS
        // =====================================

        await client.query(`
            CREATE TABLE IF NOT EXISTS simulation_settings (
                id SMALLINT PRIMARY KEY
                    DEFAULT 1
                    CHECK (id = 1),

                mode VARCHAR(20) NOT NULL
                    DEFAULT 'automatic'
                    CHECK (
                        mode IN ('automatic', 'manual')
                    ),

                manual_crash_point NUMERIC(12,2),

                updated_by BIGINT
                    REFERENCES users(id)
                    ON DELETE SET NULL,

                updated_at TIMESTAMPTZ
                    NOT NULL DEFAULT NOW(),

                CHECK (
                    manual_crash_point IS NULL
                    OR (
                        manual_crash_point >= 1.00
                        AND manual_crash_point <= 1000000.00
                    )
                )
            )
        `);

        // Start in automatic mode.
        await client.query(`
            INSERT INTO simulation_settings (
                id,
                mode,
                manual_crash_point
            )
            VALUES (1, 'automatic', NULL)
            ON CONFLICT (id) DO NOTHING
        `);

        // =====================================
        // ROUND SIMULATION METADATA
        // =====================================

        await client.query(`
            ALTER TABLE game_rounds
            ADD COLUMN IF NOT EXISTS
                generation_mode VARCHAR(20)
                NOT NULL DEFAULT 'automatic'
        `);

        await client.query(`
            ALTER TABLE game_rounds
            ADD COLUMN IF NOT EXISTS
                configured_by BIGINT
                REFERENCES users(id)
                ON DELETE SET NULL
        `);

        await client.query(`
            ALTER TABLE game_rounds
            ADD COLUMN IF NOT EXISTS
                is_simulation BOOLEAN
                NOT NULL DEFAULT TRUE
        `);

        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = 'game_rounds_generation_mode_check'
                      AND conrelid = 'game_rounds'::regclass
                ) THEN
                    ALTER TABLE game_rounds
                    ADD CONSTRAINT game_rounds_generation_mode_check
                    CHECK (
                        generation_mode IN ('automatic', 'manual')
                    );
                END IF;
            END
            $$
        `);

        // =====================================
        // ADMIN CHANGE AUDIT LOG
        // =====================================

        await client.query(`
            CREATE TABLE IF NOT EXISTS
                simulation_settings_audit (
                    id BIGINT GENERATED ALWAYS
                        AS IDENTITY PRIMARY KEY,

                    admin_user_id BIGINT
                        REFERENCES users(id)
                        ON DELETE SET NULL,

                    previous_mode VARCHAR(20),
                    new_mode VARCHAR(20) NOT NULL,

                    previous_crash_point NUMERIC(12,2),
                    new_crash_point NUMERIC(12,2),

                    created_at TIMESTAMPTZ
                        NOT NULL DEFAULT NOW()
                )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
                idx_simulation_audit_created
            ON simulation_settings_audit (
                created_at DESC
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
                idx_game_rounds_generation_mode
            ON game_rounds (
                generation_mode
            )
        `);

        await client.query("COMMIT");

        console.log(
            "Migration 003 completed successfully."
        );

        console.log(
            "Admin simulation settings are ready."
        );
    } catch (error) {
        await client.query("ROLLBACK");

        console.error(
            "Migration 003 failed:",
            error.message
        );

        process.exitCode = 1;
    } finally {
        client.release();
        await closeDatabase();
    }
}

runMigration();
