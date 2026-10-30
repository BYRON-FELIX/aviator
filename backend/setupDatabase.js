
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function setupDatabase() {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
        throw new Error(
            "DATABASE_URL is missing from backend/.env"
        );
    }

    const pool = new Pool({
        connectionString: databaseUrl,
        ssl:
            process.env.DATABASE_SSL === "true"
                ? { rejectUnauthorized: true }
                : false,
        connectionTimeoutMillis: 10000
    });

    try {
        console.log("Connecting to PostgreSQL...");

        const client = await pool.connect();

        try {
            console.log("Connected successfully.");

            const schemaPath = path.join(
                __dirname,
                "schema.sql"
            );

            const schema = fs.readFileSync(
                schemaPath,
                "utf8"
            );

            await client.query("BEGIN");

            try {
                await client.query(schema);
                await client.query("COMMIT");

                console.log(
                    "Database tables created successfully."
                );
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        } finally {
            client.release();
        }
    } catch (error) {
        console.error(
            "Database setup failed:",
            error.message
        );

        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

setupDatabase();
