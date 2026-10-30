require("dotenv").config();
const { query, closeDatabase } = require("./database");
(async () => {
    try {
        await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS auto_cashout NUMERIC(12,2)
            CHECK (auto_cashout IS NULL OR auto_cashout BETWEEN 1.01 AND 1000000)`);
        console.log("Migration 005 complete: auto cash-out targets enabled.");
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await closeDatabase(); }
})();
