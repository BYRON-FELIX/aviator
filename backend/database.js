
const { Pool } = require("pg");

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error(
        "DATABASE_URL is missing. Add it to your backend .env file."
    );
}

const pool = new Pool({
    connectionString: databaseUrl,

    // Enable SSL for hosted databases when configured.
    ssl:
        process.env.DATABASE_SSL === "true"
            ? { rejectUnauthorized: true }
            : false,

    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on("error", (error) => {
    console.error(
        "Unexpected PostgreSQL connection error:",
        error.message
    );
});

async function query(text, params = []) {
    return pool.query(text, params);
}

async function getClient() {
    return pool.connect();
}

async function closeDatabase() {
    await pool.end();
}

module.exports = {
    pool,
    query,
    getClient,
    closeDatabase
};
