require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { pool, closeDatabase } = require("./database");
(async () => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(731211)");
        await client.query(fs.readFileSync(path.join(__dirname, "walletWithdrawals.sql"), "utf8"));
        await client.query("COMMIT");
        console.log("Migration 008 complete: withdrawals, held funds and payout ledger.");
    } catch (error) {
        await client.query("ROLLBACK"); console.error(error.message); process.exitCode = 1;
    } finally { client.release(); await closeDatabase(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
