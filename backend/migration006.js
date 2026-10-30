require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { query, closeDatabase } = require("./database");
(async () => {
    try {
        await query(fs.readFileSync(path.join(__dirname, "cashout.sql"), "utf8"));
        console.log("Migration 006 complete: single-call atomic cash-out.");
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await closeDatabase(); }
})();
