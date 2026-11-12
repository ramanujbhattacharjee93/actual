import type {
  CreditCardBudgetConfig,
  CreditCardBudgetIssue,
  CreditCardBudgetReady,
  CreditCardBudgetState,
} from '#shared/credit-card-budget';

import { sumReserveAmounts as sum } from './credit-card-reserves';

export type CreditCardMonthCategory = {
  id: string;
  isIncome: boolean;
  assigned: number;
  carryover: boolean;
};

export type CreditCardMonthTransaction = {
  id: string;
  account: string;
  category: string | null;
  amount: number;
  date: number;
  is_parent: number;
  is_child: number;
  parent_id: string | null;
  starting_balance_flag: number | null;
  error: string | null;
  transfer_id: string | null;
  transfer_account: string | null;
  transfer_amount: number | null;
  transfer_date: number | null;
  transfer_back: string | null;
  transfer_offbudget: number | null;
};

/**
 * Cash envelopes plus card payment reserves, calculated from the beginning of
 * the budget. Credit overspending becomes debt, not next month's cash deficit.
 */
export function calculateCreditCardMonth({
  month,
  config,
  categories,
  transactions,
  buffered,
  previous,
}: {
  month: string;
  config: CreditCardBudgetConfig;
  categories: CreditCardMonthCategory[];
  transactions: CreditCardMonthTransaction[];
  buffered: number;
  previous?: CreditCardBudgetState;
}): CreditCardBudgetState {
  if (previous?.status === 'blocked') {
    return previous;
  }
  const issues: CreditCardBudgetIssue[] = [];
  const result: CreditCardBudgetReady = {
    status: 'ready',
    month,
    categories: {},
    cards: [],
    income: 0,
    fromLastMonth: previous ? sum(previous.toBudget, previous.buffered) : 0,
    lastMonthOverspent: previous ? -previous.cashOverspent : 0,
    availableFunds: 0,
    totalBudgeted: 0,
    totalSpent: 0,
    totalAvailable: 0,
    buffered: sum(buffered),
    toBudget: 0,
    cashOverspent: 0,
    cashBalance: previous?.cashBalance ?? 0,
  };
  const paymentCategories = new Set(
    config.cards.map(card => card.paymentCategoryId),
  );
  const cards = new Map(
    config.cards.map(card => [
      card.accountId,
      {
        ...card,
        balance:
          previous?.cards.find(old => old.accountId === card.accountId)
            ?.balance ?? 0,
        fundedSpending: 0,
        payments: 0,
      },
    ]),
  );
  const incomeCategories = new Set<string>();
  const spending = new Map<
    string,
    { cash: number; cards: Map<string, number> }
  >();

  for (const transaction of transactions) {
    if (transaction.is_parent) {
      const children = transactions.filter(
        child => child.parent_id === transaction.id && child.is_child,
      );
      if (
        children.length === 0 ||
        sum(...children.map(child => child.amount)) !== transaction.amount ||
        children.some(
          child =>
            child.account !== transaction.account ||
            child.date !== transaction.date,
        )
      ) {
        issues.push({ code: 'invalid-split', transactionId: transaction.id });
      }
    } else if (
      transaction.is_child &&
      !transactions.some(
        parent => parent.id === transaction.parent_id && parent.is_parent,
      )
    ) {
      issues.push({ code: 'invalid-split', transactionId: transaction.id });
    }
  }
  for (const category of categories) {
    const assigned = sum(category.assigned);
    if (category.carryover) {
      issues.push({
        code: 'unsupported-carryover',
        categoryId: category.id,
      });
    }
    if (category.isIncome) {
      incomeCategories.add(category.id);
    } else {
      result.totalBudgeted = sum(result.totalBudgeted, -assigned);
    }
    result.categories[category.id] = {
      assigned,
      activity: 0,
      available: category.isIncome
        ? 0
        : sum(
            assigned,
            Math.max(0, previous?.categories[category.id]?.available ?? 0),
          ),
      creditOverspent: 0,
      cashOverspent: 0,
    };
    spending.set(category.id, { cash: 0, cards: new Map() });
  }

  for (const transaction of transactions) {
    sum(transaction.amount);
    if (transaction.error) {
      issues.push({ code: 'invalid-split', transactionId: transaction.id });
    }
    const card = cards.get(transaction.account);
    if (!card && !transaction.is_child) {
      result.cashBalance = sum(result.cashBalance, transaction.amount);
    }
    if (card && !transaction.is_child) {
      card.balance = sum(card.balance, transaction.amount);
      if (card.balance > 0) {
        issues.push({
          code: 'positive-card-balance',
          accountId: card.accountId,
          transactionId: transaction.id,
        });
      }
    }
    if (transaction.is_parent) {
      continue;
    }
    if (transaction.transfer_id) {
      const otherCard = transaction.transfer_account
        ? cards.get(transaction.transfer_account)
        : undefined;
      if (card || otherCard) {
        if (
          transaction.is_child ||
          transaction.transfer_offbudget !== 0 ||
          transaction.transfer_amount !== -transaction.amount ||
          transaction.transfer_back !== transaction.id ||
          transaction.transfer_date !== transaction.date ||
          (card && (otherCard || transaction.amount < 0))
        ) {
          issues.push({
            code: 'unsupported-transfer',
            transactionId: transaction.id,
          });
        } else if (card) {
          card.payments = sum(card.payments, transaction.amount);
        }
        continue;
      }
      if (transaction.transfer_offbudget === 0) {
        if (
          transaction.transfer_amount !== -transaction.amount ||
          transaction.transfer_back !== transaction.id ||
          transaction.transfer_date !== transaction.date
        ) {
          issues.push({
            code: 'unsupported-transfer',
            transactionId: transaction.id,
          });
        }
        continue;
      }
      if (transaction.transfer_offbudget === null) {
        issues.push({
          code: 'unsupported-transfer',
          transactionId: transaction.id,
        });
        continue;
      }
    }
    const category = transaction.category
      ? result.categories[transaction.category]
      : undefined;
    if (!category || !transaction.category) {
      issues.push({
        code: 'uncategorized-spending',
        transactionId: transaction.id,
      });
      continue;
    }
    if (paymentCategories.has(transaction.category)) {
      issues.push({
        code: 'payment-category-transaction',
        categoryId: transaction.category,
        transactionId: transaction.id,
      });
      continue;
    }
    if (incomeCategories.has(transaction.category)) {
      // Starting debt and statement credits change debt, not spendable cash.
      if (!card) {
        category.activity = sum(category.activity, transaction.amount);
        result.income = sum(result.income, transaction.amount);
      } else if (transaction.amount < 0 && !transaction.starting_balance_flag) {
        issues.push({
          code: 'uncategorized-spending',
          transactionId: transaction.id,
        });
      }
      continue;
    }
    if (transaction.starting_balance_flag) {
      issues.push({
        code: 'uncategorized-spending',
        transactionId: transaction.id,
      });
      continue;
    }
    category.activity = sum(category.activity, transaction.amount);
    const categorySpending = spending.get(transaction.category);
    if (!categorySpending) {
      throw new Error('Missing credit-card spending category.');
    }
    if (card) {
      categorySpending.cards.set(
        card.accountId,
        sum(
          categorySpending.cards.get(card.accountId) ?? 0,
          -transaction.amount,
        ),
      );
    } else {
      categorySpending.cash = sum(categorySpending.cash, -transaction.amount);
    }
  }

  for (const category of categories) {
    if (category.isIncome || paymentCategories.has(category.id)) {
      continue;
    }
    const amounts = spending.get(category.id);
    const envelope = result.categories[category.id];
    if (!amounts || !envelope) {
      throw new Error('Missing credit-card envelope.');
    }
    // Refunds reverse payment reserves even if the purchase was in a prior
    // month. Negative payment reserves must remain visible, not be clamped.
    const refunds = sum(
      ...[...amounts.cards.values()].filter(amount => amount < 0),
    );
    const purchases = [...amounts.cards].filter(([, amount]) => amount > 0);
    const totalPurchases = sum(...purchases.map(([, amount]) => amount));
    const fundsForCards = Math.max(
      0,
      sum(envelope.available, -amounts.cash, -refunds),
    );
    if (totalPurchases > fundsForCards && purchases.length > 1) {
      issues.push({
        code: 'ambiguous-card-funding',
        categoryId: category.id,
      });
    } else {
      for (const [accountId, amount] of amounts.cards) {
        const card = cards.get(accountId);
        if (card) {
          card.fundedSpending = sum(
            card.fundedSpending,
            amount < 0 ? amount : Math.min(amount, fundsForCards),
          );
        }
      }
    }
    const availableBeforeActivity = envelope.available;
    envelope.available = sum(envelope.available, envelope.activity);
    const overspent = Math.max(0, -envelope.available);
    envelope.cashOverspent = Math.min(
      overspent,
      Math.max(0, sum(amounts.cash, -availableBeforeActivity)),
    );
    envelope.creditOverspent = sum(overspent, -envelope.cashOverspent);
    result.cashOverspent = sum(result.cashOverspent, envelope.cashOverspent);
  }

  for (const card of cards.values()) {
    const envelope = result.categories[card.paymentCategoryId];
    if (!envelope || incomeCategories.has(card.paymentCategoryId)) {
      issues.push({
        code: 'invalid-mapping',
        accountId: card.accountId,
        categoryId: card.paymentCategoryId,
      });
      continue;
    }
    envelope.activity = sum(card.fundedSpending, -card.payments);
    envelope.available = sum(envelope.available, envelope.activity);
    envelope.cashOverspent = Math.max(0, -envelope.available);
    result.cashOverspent = sum(result.cashOverspent, envelope.cashOverspent);
    const debt = Math.max(0, -card.balance);
    result.cards.push({
      ...card,
      paymentAvailable: envelope.available,
      unfundedDebt: Math.max(0, sum(debt, -Math.max(0, envelope.available))),
      paymentShortfall: envelope.cashOverspent,
      excessReserve: Math.max(0, sum(envelope.available, -debt)),
    });
  }

  if (issues.length > 0) {
    return { status: 'blocked', month, issues };
  }
  for (const category of categories) {
    if (!category.isIncome) {
      if (!paymentCategories.has(category.id)) {
        result.totalSpent = sum(
          result.totalSpent,
          result.categories[category.id].activity,
        );
      }
      result.totalAvailable = sum(
        result.totalAvailable,
        result.categories[category.id].available,
      );
    }
  }
  result.availableFunds = sum(result.income, result.fromLastMonth);
  result.toBudget = sum(
    result.availableFunds,
    result.lastMonthOverspent,
    result.totalBudgeted,
    -result.buffered,
  );
  const accountedCash = sum(
    result.toBudget,
    result.buffered,
    result.totalAvailable,
    ...Object.values(result.categories).map(
      category => category.creditOverspent,
    ),
  );
  if (accountedCash !== result.cashBalance) {
    return {
      status: 'blocked',
      month,
      issues: [{ code: 'unbalanced-cash' }],
    };
  }
  return result;
}
