
require("dotenv").config();

const readline = require("readline");
const { pool, closeDatabase } = require("./database");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => {
        rl.question(question, answer => {
            resolve(answer.trim());
        });
    });
}

async function createAdmin() {
    const client = await pool.connect();

    try {
        console.log("\n=================================");
        console.log(" AVIATOR ADMIN ACCOUNT SETUP");
        console.log("=================================\n");

        const username = await ask(
            "Enter the username to promote: "
        );

        if (!username) {
            throw new Error("Username is required");
        }

        const result = await client.query(
            `SELECT id, username, role
             FROM users
             WHERE username = $1`,
            [username]
        );

        if (!result.rows.length) {
            throw new Error(
                "User not found. Register the account first."
            );
        }

        const user = result.rows[0];

        console.log("\nAccount found:");
        console.log(`Username: ${user.username}`);
        console.log(`User ID: ${user.id}`);
        console.log(`Current role: ${user.role}`);

        if (user.role === "admin") {
            console.log(
                "\nThis account is already an administrator."
            );
            return;
        }

        const confirmation = await ask(
            "\nType PROMOTE to grant administrator access: "
        );

        if (confirmation !== "PROMOTE") {
            console.log(
                "\nOperation cancelled. No changes made."
            );
            return;
        }

        await client.query("BEGIN");

        const updated = await client.query(
            `UPDATE users
             SET role = 'admin'
             WHERE id = $1
               AND role = 'player'
             RETURNING id, username, role`,
            [user.id]
        );

        if (!updated.rows.length) {
            throw new Error(
                "Account could not be promoted"
            );
        }

        await client.query("COMMIT");

        console.log("\n=================================");
        console.log(" ADMINISTRATOR CREATED");
        console.log("=================================");
        console.log(`Username: ${updated.rows[0].username}`);
        console.log(`Role: ${updated.rows[0].role}`);
        console.log("\nYou can now access admin API endpoints.");
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {
            // Ignore rollback if no transaction is active.
        }

        console.error("\nError:", error.message);
        process.exitCode = 1;
    } finally {
        client.release();
        rl.close();
        await closeDatabase();
    }
}

createAdmin();
