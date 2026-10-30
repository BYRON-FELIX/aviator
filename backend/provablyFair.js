const crypto = require("crypto");

class ProvablyFair {
    constructor(houseEdge = 0.01) {
        this.houseEdge = houseEdge;
    }

    /**
     * Generate a cryptographically secure server seed.
     */
    generateServerSeed() {
        return crypto.randomBytes(32).toString("hex");
    }

    /**
     * Create the SHA-256 commitment that can be published
     * before the round starts.
     */
    createHash(serverSeed) {
        return crypto
            .createHash("sha256")
            .update(serverSeed)
            .digest("hex");
    }

    /**
     * Convert the first 52 bits of the SHA-256 hash
     * into a deterministic value between 0 and 1.
     */
    hashToRandom(hash) {
        if (!/^[0-9a-f]{64}$/i.test(hash)) {
            throw new Error("Invalid SHA-256 hash");
        }

        const value = parseInt(hash.slice(0, 13), 16);
        const maxValue = 0xFFFFFFFFFFFFF;

        return value / maxValue;
    }

    /**
     * Calculate the crash point from the server seed.
     *
     * The same server seed will always produce
     * exactly the same crash point.
     */
    calculateCrashPoint(serverSeed) {
        if (
            typeof serverSeed !== "string" ||
            serverSeed.length === 0
        ) {
            throw new Error("Invalid server seed");
        }

        const hash = this.createHash(serverSeed);
        const random = this.hashToRandom(hash);

        const crashPoint =
            (1 - this.houseEdge) / (1 - random);

        return Math.max(
            1.00,
            Math.floor(crashPoint * 100) / 100
        );
    }

    /**
     * Verify that a server seed matches
     * a previously published hash.
     */
    verifyHash(serverSeed, expectedHash) {
        const actualHash = this.createHash(serverSeed);

        return (
            actualHash.toLowerCase() ===
            expectedHash.toLowerCase()
        );
    }

    /**
     * Verify an entire round.
     */
    verifyRound(
        serverSeed,
        expectedHash,
        expectedCrashPoint
    ) {
        const hashMatches =
            this.verifyHash(
                serverSeed,
                expectedHash
            );

        const calculatedCrashPoint =
            this.calculateCrashPoint(serverSeed);

        const crashPointMatches =
            calculatedCrashPoint ===
            Number(expectedCrashPoint);

        return {
            valid:
                hashMatches &&
                crashPointMatches,

            hashMatches,

            crashPointMatches,

            calculatedHash:
                this.createHash(serverSeed),

            calculatedCrashPoint
        };
    }
}

module.exports = ProvablyFair;