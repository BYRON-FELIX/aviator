class TransactionManager {
    constructor() {
        this.transactions = [];
        this.nextTransactionId = 1;
    }

    create({
        userId,
        type,
        amount,
        balanceBefore,
        balanceAfter,
        reference = null,
        metadata = {}
    }) {
        if (!userId) {
            throw new Error("User ID is required");
        }

        if (!type) {
            throw new Error(
                "Transaction type is required"
            );
        }

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            throw new Error(
                "Transaction amount must be greater than 0"
            );
        }

        const transaction = {
            id: this.nextTransactionId++,

            userId,

            type,

            amount:
                this.roundMoney(amount),

            balanceBefore:
                this.roundMoney(
                    balanceBefore
                ),

            balanceAfter:
                this.roundMoney(
                    balanceAfter
                ),

            reference,

            metadata,

            createdAt: Date.now()
        };

        this.transactions.push(
            transaction
        );

        return transaction;
    }

    getTransaction(id) {
        return (
            this.transactions.find(
                (transaction) =>
                    transaction.id ===
                    Number(id)
            ) || null
        );
    }

    getUserTransactions(userId) {
        return this.transactions
            .filter(
                (transaction) =>
                    transaction.userId ===
                    userId
            )
            .sort(
                (a, b) =>
                    b.createdAt -
                    a.createdAt
            );
    }

    getAllTransactions() {
        return [...this.transactions].sort(
            (a, b) =>
                b.createdAt -
                a.createdAt
        );
    }

    roundMoney(amount) {
        return (
            Math.round(
                (amount +
                    Number.EPSILON) *
                    100
            ) / 100
        );
    }
}

module.exports = TransactionManager;