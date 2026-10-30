require("dotenv").config();
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { query, closeDatabase } = require("./database");
const BetManager = require("./betManager");
const WalletManager = require("./walletManager");
const RoundManager = require("./roundManager");
const GameLock = require("./gameLock");

test("virtual credit settlement, concurrency and crash boundaries", async () => {
    const lock = new GameLock();
    const wallets = new WalletManager();
    const rounds = new RoundManager();
    let round, userId;
    const seed = crypto.randomBytes(32).toString("hex");
    const bets = new BetManager({ getCurrentRound: () => round });
    try {
        await lock.acquire();
        const user = await query(`INSERT INTO users (username, password_hash, password_salt)
            VALUES ($1, 'test-only', 'test-only') RETURNING id`,
            [`bet_test_${crypto.randomBytes(8).toString("hex")}`]);
        userId = String(user.rows[0].id);
        await wallets.createWallet(userId);
        await wallets.deposit(userId, 1000, { type: "adjustment", reference: `test:${userId}` });
        round = await rounds.createRound({ serverSeedHash: crypto.createHash("sha256").update(seed).digest("hex") });
        round.crashPoint = 3;
        const placement = { userId, roundNumber: round.roundNumber, slot: 1, amount: 10, autoCashout: 2 };
        const duplicates = await Promise.all([bets.placeBet(placement), bets.placeBet(placement)]);
        assert.equal(duplicates[0].id, duplicates[1].id);
        assert.equal(await wallets.getBalance(userId), 990);
        await assert.rejects(bets.placeBet({ ...placement, slot: 2, amount: 9999 }), /Insufficient/);
        await assert.rejects(bets.placeBet({ ...placement, slot: 2, autoCashout: 1 }), /Invalid auto/);
        const manual = await bets.placeBet({ ...placement, slot: 2, autoCashout: null });
        assert.equal(await wallets.getBalance(userId), 980);
        await rounds.startRound(round.roundNumber);
        round.status = "running";
        await query(`UPDATE game_rounds SET started_at = clock_timestamp() - INTERVAL '1 second' WHERE round_number = $1`, [round.roundNumber]);
        await assert.rejects(bets.placeBet(placement), /Betting is closed/);
        await bets.settleAutoCashouts();
        assert.equal((await bets.getBet(duplicates[0].id)).status, "active");
        const cashouts = await Promise.allSettled([
            bets.cashOut({ userId, betId: manual.id }),
            bets.cashOut({ userId, betId: manual.id })
        ]);
        assert.equal(cashouts.filter(result => result.status === "fulfilled").length, 1,
            cashouts.filter(result => result.status === "rejected").map(result => result.reason.message).join("; "));
        const manualBet = await bets.getBet(manual.id);
        assert.equal(manualBet.status, "cashed_out");
        // A delayed automatic settlement still pays its exact target; late manual requests fail.
        await query(`UPDATE game_rounds SET started_at = clock_timestamp() - INTERVAL '15 seconds' WHERE round_number = $1`, [round.roundNumber]);
        await assert.rejects(bets.cashOut({ userId, betId: duplicates[0].id }), /Aircraft already crashed/);
        await bets.settleAutoCashouts();
        await bets.settleAutoCashouts();
        const auto = await bets.getBet(duplicates[0].id);
        assert.equal(auto.cashOutMultiplier, 2);
        assert.equal(auto.payout, 20);
        assert.equal(await wallets.getBalance(userId), 980 + manualBet.payout + 20);
        await rounds.crashRound({ roundNumber: round.roundNumber, serverSeed: seed, crashPoint: 3 });
        // Reuse only this test fixture to exercise a target equal to the crash point.
        await query("DELETE FROM transactions WHERE user_id = $1", [userId]);
        await query("DELETE FROM bets WHERE user_id = $1", [userId]);
        await query("UPDATE game_rounds SET status = 'waiting', server_seed = NULL, crash_point = NULL WHERE round_number = $1", [round.roundNumber]);
        round.status = "waiting";
        const loses = await bets.placeBet({ ...placement, autoCashout: 3 });
        await rounds.startRound(round.roundNumber);
        round.status = "running";
        await query(`UPDATE game_rounds SET started_at = clock_timestamp() - INTERVAL '15 seconds' WHERE round_number = $1`, [round.roundNumber]);
        await bets.settleAutoCashouts();
        await rounds.crashRound({ roundNumber: round.roundNumber, serverSeed: seed, crashPoint: 3 });
        assert.equal((await bets.getBet(loses.id)).status, "lost");
    } finally {
        if (userId) {
            await query("DELETE FROM transactions WHERE user_id = $1", [userId]);
            await query("DELETE FROM bets WHERE user_id = $1", [userId]);
            await query("DELETE FROM wallets WHERE user_id = $1", [userId]);
            await query("DELETE FROM users WHERE id = $1", [userId]);
        }
        if (round) await query("DELETE FROM game_rounds WHERE round_number = $1", [round.roundNumber]);
        await lock.release();
        await closeDatabase();
    }
});
