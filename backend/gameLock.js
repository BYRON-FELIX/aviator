const { Client } = require("pg");

class GameLock {
    constructor() {
        this.client = null;
        this.lockKey = 731207;
        this.locked = false;
        this.acquiring = null;
        this.releasing = false;
    }

    async acquire() {
        if (this.locked && this.client) {
            return true;
        }

        if (this.acquiring) {
            return this.acquiring;
        }

        this.acquiring = this.acquireInternal();

        try {
            return await this.acquiring;
        } finally {
            this.acquiring = null;
        }
    }

    async acquireInternal() {
        const connectionString =
            process.env.GAME_LOCK_DATABASE_URL;

        if (!connectionString) {
            throw new Error(
                "GAME_LOCK_DATABASE_URL is missing from .env"
            );
        }

        const url = new URL(connectionString);

        if (url.hostname.includes("-pooler")) {
            throw new Error(
                "Game lock requires a direct Neon connection, not a pooled connection."
            );
        }

        const client = new Client({
            connectionString,
            ssl: {
                rejectUnauthorized: true
            },
            connectionTimeoutMillis: 10000,
            keepAlive: true
        });

        let connected = false;
        let acquired = false;

        try {
            await client.connect();
            connected = true;

            const result = await client.query(
                "SELECT pg_try_advisory_lock($1) AS acquired",
                [this.lockKey]
            );

            acquired = result.rows[0]?.acquired === true;

            if (!acquired) {
                throw new Error(
                    "Another game server is already running."
                );
            }

            this.client = client;
            this.locked = true;

            client.on("error", (error) => {
                console.error(
                    "Game lock connection lost:",
                    error.message
                );

                this.locked = false;

                // Never continue generating rounds
                // after losing exclusive ownership.
                process.exit(1);
            });

            console.log(
                "Exclusive game engine lock acquired."
            );

            return true;
        } catch (error) {
            this.locked = false;
            this.client = null;

            if (connected) {
                if (acquired) {
                    try {
                        await client.query(
                            "SELECT pg_advisory_unlock($1)",
                            [this.lockKey]
                        );
                    } catch (_) {
                        // Disconnecting also releases PostgreSQL session locks.
                    }
                }

                try {
                    await client.end();
                } catch (_) {
                    // The connection may already be closed.
                }
            }

            throw error;
        }
    }

    async release() {
        if (this.releasing) {
            return;
        }

        if (!this.client) {
            return;
        }

        this.releasing = true;
        const client = this.client;
        this.client = null;
        this.locked = false;

        try {
            await client.query(
                "SELECT pg_advisory_unlock($1)",
                [this.lockKey]
            );
        } catch (error) {
            console.error(
                "Unable to unlock game session:",
                error.message
            );
        } finally {
            try {
                await client.end();
            } finally {
                this.releasing = false;
            }
        }

        console.log("Game engine lock released.");
    }

    isLocked() {
        return this.locked && this.client !== null;
    }
}

module.exports = GameLock;
