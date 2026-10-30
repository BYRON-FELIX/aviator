const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { query } = require("./database");

class AuthManager {
    constructor() {
        this.jwtSecret = process.env.JWT_SECRET;

        if (
            !this.jwtSecret ||
            Buffer.byteLength(this.jwtSecret, "utf8") < 32
        ) {
            throw new Error(
                "JWT_SECRET must contain at least 32 bytes. Check backend/.env."
            );
        }
    }

    async register({ username, password }) {
        if (
            typeof username !== "string" ||
            username.trim().length < 3 ||
            username.trim().length > 50
        ) {
            throw new Error(
                "Username must contain between 3 and 50 characters"
            );
        }

        if (
            typeof password !== "string" ||
            password.length < 8
        ) {
            throw new Error(
                "Password must contain at least 8 characters"
            );
        }

        const cleanUsername = username.trim().toLowerCase();

        const existing = await query(
            "SELECT id FROM users WHERE username = $1",
            [cleanUsername]
        );

        if (existing.rows.length > 0) {
            throw new Error("Username is already registered");
        }

        const { salt, hash } = await this.hashPassword(password);

        try {
            const result = await query(
                `INSERT INTO users
                    (username, password_hash, password_salt)
                 VALUES ($1, $2, $3)
                 RETURNING id, username, created_at`,
                [cleanUsername, hash, salt]
            );

            return this.publicUser(result.rows[0]);
        } catch (error) {
            if (error.code === "23505") {
                throw new Error("Username is already registered");
            }

            throw error;
        }
    }

    async login({ username, password }) {
        if (
            typeof username !== "string" ||
            typeof password !== "string"
        ) {
            throw new Error("Username and password are required");
        }

        const cleanUsername = username.trim().toLowerCase();

        const result = await query(
            `SELECT id, username, password_hash,
                    password_salt, created_at
             FROM users
             WHERE username = $1`,
            [cleanUsername]
        );

        const user = result.rows[0];

        if (!user) {
            throw new Error("Invalid username or password");
        }

        const valid = await this.verifyPassword(
            password,
            user.password_salt,
            user.password_hash
        );

        if (!valid) {
            throw new Error("Invalid username or password");
        }

        return {
            user: this.publicUser(user),
            token: this.createToken(user)
        };
    }

    createToken(user) {
        return jwt.sign(
            {
                sub: String(user.id),
                username: user.username
            },
            this.jwtSecret,
            {
                algorithm: "HS256",
                expiresIn: "24h"
            }
        );
    }

    verifyToken(token) {
        if (!token || typeof token !== "string") {
            throw new Error("Authentication token is required");
        }

        try {
            return jwt.verify(token, this.jwtSecret, {
                algorithms: ["HS256"]
            });
        } catch (error) {
            throw new Error(
                "Invalid or expired authentication token"
            );
        }
    }

    async hashPassword(password) {
        const salt = crypto.randomBytes(16).toString("hex");

        const hash = await new Promise((resolve, reject) => {
            crypto.pbkdf2(
                password,
                Buffer.from(salt, "hex"),
                210000,
                64,
                "sha512",
                (error, derivedKey) => {
                    if (error) {
                        return reject(error);
                    }

                    resolve(derivedKey.toString("hex"));
                }
            );
        });

        return { salt, hash };
    }

    async verifyPassword(password, saltHex, hashHex) {
        const calculated = await new Promise((resolve, reject) => {
            crypto.pbkdf2(
                password,
                Buffer.from(saltHex, "hex"),
                210000,
                64,
                "sha512",
                (error, derivedKey) => {
                    if (error) {
                        return reject(error);
                    }

                    resolve(derivedKey);
                }
            );
        });

        const stored = Buffer.from(hashHex, "hex");

        if (stored.length !== calculated.length) {
            return false;
        }

        return crypto.timingSafeEqual(stored, calculated);
    }

    async getUser(userId) {
        const result = await query(
            `SELECT id, username, created_at
             FROM users
             WHERE id = $1`,
            [userId]
        );

        return result.rows[0]
            ? this.publicUser(result.rows[0])
            : null;
    }

    publicUser(user) {
        return {
            id: String(user.id),
            username: user.username,
            createdAt: user.created_at
        };
    }

    async getAllUsers() {
        const result = await query(
            `SELECT id, username, created_at
             FROM users
             ORDER BY id ASC`
        );

        return result.rows.map(user =>
            this.publicUser(user)
        );
    }
}

module.exports = AuthManager;
