
const { pool } = require("./database");

class SimulationManager {
    constructor() {
        this.allowedModes = ["automatic", "manual"];
        this.minCrashPoint = 1.00;
        this.maxCrashPoint = 1000000.00;
    }

    formatSettings(row) {
        if (!row) return null;

        return {
            mode: row.mode,
            manualCrashPoint:
                row.manual_crash_point === null
                    ? null
                    : Number(row.manual_crash_point),
            updatedBy:
                row.updated_by === null
                    ? null
                    : String(row.updated_by),
            updatedAt: row.updated_at
        };
    }

    validateCrashPoint(value) {
        if (
            typeof value !== "number" ||
            !Number.isFinite(value)
        ) {
            throw new Error(
                "Crash point must be a valid number"
            );
        }

        if (
            value < this.minCrashPoint ||
            value > this.maxCrashPoint
        ) {
            throw new Error(
                `Crash point must be between ${this.minCrashPoint}x and ${this.maxCrashPoint}x`
            );
        }

        const hundredths = Math.round(value * 100);

        if (
            Math.abs(value * 100 - hundredths) >
            0.000001
        ) {
            throw new Error(
                "Crash point must have at most two decimal places"
            );
        }

        return hundredths / 100;
    }

    async getSettings() {
        const result = await pool.query(
            `SELECT *
             FROM simulation_settings
             WHERE id = 1`
        );

        if (!result.rows.length) {
            throw new Error(
                "Simulation settings not initialized"
            );
        }

        return this.formatSettings(result.rows[0]);
    }

    async updateSettings({
        adminUserId,
        mode,
        manualCrashPoint = null
    }) {
        if (!adminUserId) {
            throw new Error(
                "Administrator identity is required"
            );
        }

        if (!this.allowedModes.includes(mode)) {
            throw new Error(
                "Invalid simulation mode"
            );
        }

        let validatedCrashPoint = null;

        if (mode === "manual") {
            validatedCrashPoint =
                this.validateCrashPoint(manualCrashPoint);
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const previousResult = await client.query(
                `SELECT *
                 FROM simulation_settings
                 WHERE id = 1
                 FOR UPDATE`
            );

            if (!previousResult.rows.length) {
                throw new Error(
                    "Simulation settings not initialized"
                );
            }

            const previous = previousResult.rows[0];

            const updatedResult = await client.query(
                `UPDATE simulation_settings
                 SET mode = $1,
                     manual_crash_point = $2,
                     updated_by = $3,
                     updated_at = NOW()
                 WHERE id = 1
                 RETURNING *`,
                [
                    mode,
                    validatedCrashPoint,
                    adminUserId
                ]
            );

            await client.query(
                `INSERT INTO simulation_settings_audit (
                    admin_user_id,
                    previous_mode,
                    new_mode,
                    previous_crash_point,
                    new_crash_point
                )
                VALUES ($1, $2, $3, $4, $5)`,
                [
                    adminUserId,
                    previous.mode,
                    mode,
                    previous.manual_crash_point,
                    validatedCrashPoint
                ]
            );

            await client.query("COMMIT");

            return this.formatSettings(
                updatedResult.rows[0]
            );
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async getRoundConfiguration() {
        const settings = await this.getSettings();

        if (settings.mode === "manual") {
            return {
                mode: "manual",
                crashPoint: settings.manualCrashPoint,
                configuredBy: settings.updatedBy,
                isSimulation: true
            };
        }

        return {
            mode: "automatic",
            crashPoint: null,
            configuredBy: null,
            isSimulation: true
        };
    }

    async getAuditHistory(limit = 50) {
        const safeLimit = Math.min(
            100,
            Math.max(
                1,
                Math.trunc(Number(limit) || 50)
            )
        );

        const result = await pool.query(
            `SELECT
                id,
                admin_user_id,
                previous_mode,
                new_mode,
                previous_crash_point,
                new_crash_point,
                created_at
             FROM simulation_settings_audit
             ORDER BY created_at DESC
             LIMIT $1`,
            [safeLimit]
        );

        return result.rows.map(row => ({
            id: String(row.id),
            adminUserId:
                row.admin_user_id === null
                    ? null
                    : String(row.admin_user_id),
            previousMode: row.previous_mode,
            newMode: row.new_mode,
            previousCrashPoint:
                row.previous_crash_point === null
                    ? null
                    : Number(row.previous_crash_point),
            newCrashPoint:
                row.new_crash_point === null
                    ? null
                    : Number(row.new_crash_point),
            createdAt: row.created_at
        }));
    }
}

module.exports = SimulationManager;
