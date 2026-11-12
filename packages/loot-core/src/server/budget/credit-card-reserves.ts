export type CreditCardReserveCard = {
  accountId: string;
  openingBalance: number;
  balance: number;
  openingPaymentAvailable: number;
  assigned: number;
  payments: number;
};

export type CreditCardReserveCategory = {
  categoryId: string;
  availableBeforeSpending: number;
  cashSpent: number;
  cardSpending: readonly { accountId: string; amount: number }[];
};

export type CreditCardReserveIssue = {
  code:
    | 'positive-card-balance'
    | 'prior-month-refund'
    | 'ambiguous-card-funding'
    | 'unsupported-transfer'
    | 'uncategorized-spending'
    | 'invalid-split';
  accountId?: string;
  categoryId?: string;
  transactionId?: string;
};

export type CreditCardReserveResult =
  | {
      status: 'preview';
      cards: {
        accountId: string;
        balance: number;
        fundedSpending: number;
        paymentAvailable: number;
        unfundedDebt: number;
        paymentShortfall: number;
        excessReserve: number;
      }[];
      categories: {
        categoryId: string;
        balance: number;
        fundedSpending: number;
        unfundedSpending: number;
      }[];
    }
  | { status: 'blocked'; issues: CreditCardReserveIssue[] };

export function sumReserveAmounts(...amounts: number[]): number {
  return amounts.reduce((total, amount) => {
    if (
      !Number.isSafeInteger(amount) ||
      !Number.isSafeInteger(total + amount)
    ) {
      throw new Error('Credit-card amounts must be safe integer minor units.');
    }
    return total + amount;
  }, 0);
}

/**
 * Read-only monthly projection, not a replacement for envelope budget totals.
 * Opening reserves and additional assignments are explicit inputs; this never
 * creates transactions or subtracts card reserves from Actual a second time.
 */
export function calculateCreditCardReserves({
  cards,
  categories,
}: {
  cards: readonly CreditCardReserveCard[];
  categories: readonly CreditCardReserveCategory[];
}): CreditCardReserveResult {
  const issues: CreditCardReserveIssue[] = [];
  const fundedByCard = new Map<string, number>();

  for (const card of cards) {
    if (!card.accountId || fundedByCard.has(card.accountId)) {
      throw new Error('Credit-card accounts must have unique, nonempty IDs.');
    }
    for (const amount of [
      card.openingBalance,
      card.balance,
      card.openingPaymentAvailable,
      card.assigned,
      card.payments,
    ]) {
      sumReserveAmounts(amount);
    }
    if (card.payments < 0) {
      throw new Error('Credit-card payments cannot be negative.');
    }
    if (card.openingBalance > 0 || card.balance > 0) {
      issues.push({
        code: 'positive-card-balance',
        accountId: card.accountId,
      });
    }
    fundedByCard.set(card.accountId, 0);
  }

  const categoryIds = new Set<string>();
  const categoryResults: Extract<
    CreditCardReserveResult,
    { status: 'preview' }
  >['categories'] = [];

  for (const category of categories) {
    if (!category.categoryId || categoryIds.has(category.categoryId)) {
      throw new Error('Reserve categories must have unique, nonempty IDs.');
    }
    categoryIds.add(category.categoryId);
    sumReserveAmounts(category.availableBeforeSpending);
    sumReserveAmounts(category.cashSpent);

    const spendingByCard = new Map<string, number>();
    for (const spending of category.cardSpending) {
      if (!fundedByCard.has(spending.accountId)) {
        throw new Error('Category spending references an unknown card.');
      }
      spendingByCard.set(
        spending.accountId,
        sumReserveAmounts(
          spendingByCard.get(spending.accountId) ?? 0,
          spending.amount,
        ),
      );
    }

    for (const [accountId, amount] of spendingByCard) {
      if (amount < 0) {
        // A refund from an earlier month needs that month's funding history.
        issues.push({
          code: 'prior-month-refund',
          accountId,
          categoryId: category.categoryId,
        });
      }
    }

    const cardSpent = sumReserveAmounts(...spendingByCard.values());
    // Cash spending must be covered before money can be reserved for a card.
    const fundsForCards = Math.max(
      0,
      sumReserveAmounts(category.availableBeforeSpending, -category.cashSpent),
    );
    const fundedSpending = Math.min(Math.max(0, cardSpent), fundsForCards);
    const spendingCards = [...spendingByCard].filter(
      ([, amount]) => amount > 0,
    );

    if (cardSpent > fundsForCards && spendingCards.length > 1) {
      // Do not invent a priority between cards sharing an overspent category.
      issues.push({
        code: 'ambiguous-card-funding',
        categoryId: category.categoryId,
      });
    } else {
      for (const [accountId, amount] of spendingCards) {
        fundedByCard.set(
          accountId,
          sumReserveAmounts(
            fundedByCard.get(accountId) ?? 0,
            Math.min(amount, fundedSpending),
          ),
        );
      }
    }

    categoryResults.push({
      categoryId: category.categoryId,
      balance: sumReserveAmounts(
        category.availableBeforeSpending,
        -category.cashSpent,
        -cardSpent,
      ),
      fundedSpending,
      unfundedSpending: sumReserveAmounts(cardSpent, -fundedSpending),
    });
  }

  if (issues.length > 0) {
    return { status: 'blocked', issues };
  }

  return {
    status: 'preview',
    cards: cards.map(card => {
      const fundedSpending = fundedByCard.get(card.accountId) ?? 0;
      const paymentAvailable = sumReserveAmounts(
        card.openingPaymentAvailable,
        card.assigned,
        fundedSpending,
        -card.payments,
      );
      const debt = -card.balance;

      return {
        accountId: card.accountId,
        balance: card.balance,
        fundedSpending,
        paymentAvailable,
        unfundedDebt: Math.max(
          0,
          sumReserveAmounts(debt, -Math.max(0, paymentAvailable)),
        ),
        paymentShortfall: Math.max(0, -paymentAvailable),
        excessReserve: Math.max(0, sumReserveAmounts(paymentAvailable, -debt)),
      };
    }),
    categories: categoryResults,
  };
}
