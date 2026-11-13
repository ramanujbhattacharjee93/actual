export const CREDIT_CARD_BUDGET_PREF = 'credit-card-budget-v1';

export type CreditCardBudgetConfig = {
  version: 1 | 2;
  cards: { accountId: string; paymentCategoryId: string }[];
  debtCategoryIds?: string[];
};

export function parseCreditCardBudgetConfig(
  value: string,
): CreditCardBudgetConfig {
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    !('cards' in parsed) ||
    !Array.isArray(parsed.cards) ||
    parsed.cards.length === 0
  ) {
    throw new Error('Unsupported credit-card budget configuration.');
  }
  const accounts = new Set<string>();
  const categories = new Set<string>();
  const cards = parsed.cards.map((card: unknown) => {
    if (
      !card ||
      typeof card !== 'object' ||
      !('accountId' in card) ||
      typeof card.accountId !== 'string' ||
      !card.accountId ||
      !('paymentCategoryId' in card) ||
      typeof card.paymentCategoryId !== 'string' ||
      !card.paymentCategoryId ||
      accounts.has(card.accountId) ||
      categories.has(card.paymentCategoryId)
    ) {
      throw new Error('Credit-card mappings must be distinct and nonempty.');
    }
    accounts.add(card.accountId);
    categories.add(card.paymentCategoryId);
    return {
      accountId: card.accountId,
      paymentCategoryId: card.paymentCategoryId,
    };
  });
  const debtCategoryIds: string[] = [];
  if (parsed.version === 2 && 'debtCategoryIds' in parsed) {
    if (!Array.isArray(parsed.debtCategoryIds)) {
      throw new Error('Invalid debt-only categories.');
    }
    for (const id of parsed.debtCategoryIds) {
      if (
        typeof id !== 'string' ||
        !id ||
        categories.has(id) ||
        debtCategoryIds.includes(id)
      ) {
        throw new Error('Invalid debt-only category mapping.');
      }
      debtCategoryIds.push(id);
    }
  }
  return {
    version: parsed.version,
    cards,
    ...(debtCategoryIds.length > 0 && { debtCategoryIds }),
  };
}

export type CreditCardBudgetIssue = {
  code:
    | 'invalid-configuration'
    | 'invalid-amount'
    | 'unbalanced-cash'
    | 'invalid-split'
    | 'invalid-mapping'
    | 'positive-card-balance'
    | 'ambiguous-card-funding'
    | 'unsupported-transfer'
    | 'uncategorized-spending'
    | 'payment-category-transaction'
    | 'unsupported-carryover';

  accountId?: string;
  categoryId?: string;
  transactionId?: string;
};

export type CreditCardBudgetReady = {
  status: 'ready';
  month: string;
  categories: Record<
    string,
    {
      assigned: number;
      activity: number;
      available: number;
      creditOverspent: number;
      cashOverspent: number;
    }
  >;
  cards: {
    accountId: string;
    paymentCategoryId: string;
    balance: number;
    fundedSpending: number;
    payments: number;
    paymentAvailable: number;
    unfundedDebt: number;
    paymentShortfall: number;
    excessReserve: number;
    interestCharged?: number;
  }[];
  income: number;
  fromLastMonth: number;
  lastMonthOverspent: number;
  availableFunds: number;
  totalBudgeted: number;
  totalSpent: number;
  totalAvailable: number;
  buffered: number;
  toBudget: number;
  cashOverspent: number;
  cashBalance: number;
  creditAdjustments?: number;
  autoBuffered?: number;
};

export type CreditCardBudgetState =
  | CreditCardBudgetReady
  | {
      status: 'blocked';
      month: string;
      issues: CreditCardBudgetIssue[];
    };
