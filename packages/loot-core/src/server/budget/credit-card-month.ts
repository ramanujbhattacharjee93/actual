import type {
  CreditCardBudgetConfig,
  CreditCardBudgetIssue,
  CreditCardBudgetReady,
  CreditCardBudgetState,
} from '#shared/credit-card-budget';

import type {
  CreditCardMonthCategory,
  CreditCardMonthTransaction,
} from './credit-card-month-v1';
import { sumReserveAmounts as sum } from './credit-card-reserves';

export type {
  CreditCardMonthCategory,
  CreditCardMonthTransaction,
} from './credit-card-month-v1';

type Spending = {
  cash: number;
  credit: { accountId: string; amount: number }[];
};

function compareTransactions(
  a: CreditCardMonthTransaction,
  b: CreditCardMonthTransaction,
) {
  return (
    a.date - b.date ||
    Number(Boolean(b.starting_balance_flag)) -
      Number(Boolean(a.starting_balance_flag)) ||
    (b.sort_order ?? 0) - (a.sort_order ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Native card accounting. Positive card balances are cash; only the part of a
 * purchase financed by debt needs a payment reserve. Transfers remain real
 * account transfers, never synthetic expenses or balancing transactions.
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
    creditAdjustments: 0,
    autoBuffered: 0,
  };
  if (buffered < 0) {
    throw new Error('Held funds cannot be negative.');
  }
  const paymentCategories = new Set(
    config.cards.map(card => card.paymentCategoryId),
  );
  const debtCategories = new Set(config.debtCategoryIds ?? []);
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
        interestCharged: 0,
      },
    ]),
  );
  const incomeCategories = new Set<string>();
  const spending = new Map<string, Spending>();
  for (const category of categories) {
    sum(category.assigned);
    if (category.isIncome) {
      incomeCategories.add(category.id);
    } else if (category.carryover) {
      issues.push({ code: 'unsupported-carryover', categoryId: category.id });
    }
    if (debtCategories.has(category.id) && category.assigned !== 0) {
      issues.push({ code: 'invalid-configuration', categoryId: category.id });
    }
    result.categories[category.id] = {
      assigned: category.assigned,
      activity: 0,
      available:
        category.isIncome || debtCategories.has(category.id)
          ? 0
          : sum(
              category.assigned,
              Math.max(0, previous?.categories[category.id]?.available ?? 0),
            ),
      creditOverspent: 0,
      cashOverspent: 0,
    };
    if (!category.isIncome) {
      result.totalBudgeted = sum(result.totalBudgeted, -category.assigned);
    }
    spending.set(category.id, { cash: 0, credit: [] });
  }

  const children = new Map<string, CreditCardMonthTransaction[]>();
  const byId = new Map(
    transactions.map(transaction => [transaction.id, transaction]),
  );
  for (const transaction of transactions) {
    sum(transaction.amount);
    if (transaction.error) {
      issues.push({ code: 'invalid-split', transactionId: transaction.id });
    }
    if (transaction.is_child) {
      const parent = transaction.parent_id
        ? byId.get(transaction.parent_id)
        : undefined;
      if (
        !parent?.is_parent ||
        transaction.is_parent ||
        parent.date !== transaction.date ||
        parent.account !== transaction.account
      ) {
        issues.push({ code: 'invalid-split', transactionId: transaction.id });
      } else {
        const list = children.get(parent.id) ?? [];
        list.push(transaction);
        children.set(parent.id, list);
      }
    }
  }

  function process(transaction: CreditCardMonthTransaction) {
    const card = cards.get(transaction.account);
    const before = card?.balance ?? 0;
    const after = card ? sum(before, transaction.amount) : 0;
    const cashChange = card
      ? sum(Math.max(0, after), -Math.max(0, before))
      : transaction.amount;
    result.cashBalance = sum(result.cashBalance, cashChange);
    if (card) {
      card.balance = after;
    }
    if (transaction.transfer_id) {
      if (
        transaction.transfer_account === null ||
        transaction.transfer_offbudget === null ||
        transaction.transfer_date === null ||
        transaction.transfer_amount !== -transaction.amount ||
        transaction.transfer_back !== transaction.id ||
        transaction.transfer_is_parent
      ) {
        issues.push({
          code: 'unsupported-transfer',
          transactionId: transaction.id,
        });
        return;
      }
      if (transaction.transfer_offbudget === 0) {
        const otherCard = cards.get(transaction.transfer_account);
        // A payment consumes reserves when cash leaves the paying account,
        // even if the receiving bank posts its reciprocal row on another date.
        if (!card && otherCard && transaction.amount < 0) {
          otherCard.payments = sum(otherCard.payments, -transaction.amount);
        } else {
          // Cash advances, positive-balance movements and transfer timing
          // affect assignable cash. Card-to-card debt transfers do not move
          // payment reserves: those allocations remain the user's choice.
          result.creditAdjustments = sum(
            result.creditAdjustments ?? 0,
            cashChange,
          );
        }
        return;
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
      return;
    }
    if (paymentCategories.has(transaction.category)) {
      issues.push({
        code: 'payment-category-transaction',
        categoryId: transaction.category,
        transactionId: transaction.id,
      });
      return;
    }
    if (incomeCategories.has(transaction.category)) {
      category.activity = sum(category.activity, cashChange);
      result.income = sum(result.income, cashChange);
      return;
    }
    if (debtCategories.has(transaction.category)) {
      if (!card) {
        issues.push({ code: 'invalid-mapping', transactionId: transaction.id });
      } else {
        card.interestCharged = sum(card.interestCharged, -transaction.amount);
        result.creditAdjustments = sum(
          result.creditAdjustments ?? 0,
          cashChange,
        );
      }
      return;
    }
    if (transaction.starting_balance_flag) {
      issues.push({
        code: 'uncategorized-spending',
        transactionId: transaction.id,
      });
      return;
    }
    category.activity = sum(category.activity, transaction.amount);
    const amounts = spending.get(transaction.category);
    if (!amounts) {
      throw new Error('Missing spending category.');
    }
    if (!card) {
      amounts.cash = sum(amounts.cash, -transaction.amount);
    } else {
      const creditAmount = sum(-transaction.amount, cashChange);
      amounts.cash = sum(amounts.cash, -cashChange);
      if (creditAmount !== 0) {
        amounts.credit.push({
          accountId: card.accountId,
          amount: creditAmount,
        });
      }
    }
  }

  for (const transaction of transactions
    .filter(row => !row.is_child)
    .sort(compareTransactions)) {
    if (transaction.is_parent) {
      const leaves = children.get(transaction.id) ?? [];
      if (
        leaves.length === 0 ||
        sum(...leaves.map(row => row.amount)) !== transaction.amount
      ) {
        issues.push({ code: 'invalid-split', transactionId: transaction.id });
        continue;
      }
      for (const leaf of leaves.sort(compareTransactions)) {
        process(leaf);
      }
    } else {
      process(transaction);
    }
  }

  for (const category of categories) {
    if (
      category.isIncome ||
      paymentCategories.has(category.id) ||
      debtCategories.has(category.id)
    ) {
      continue;
    }
    const envelope = result.categories[category.id];
    const amounts = spending.get(category.id);
    if (!envelope || !amounts) {
      throw new Error('Missing envelope.');
    }
    const beforeActivity = envelope.available;
    const funded = fundCreditSpending(
      amounts,
      sum(beforeActivity, -amounts.cash),
    );
    for (const [accountId, amount] of funded) {
      const card = cards.get(accountId);
      if (card) {
        card.fundedSpending = sum(card.fundedSpending, amount);
      }
    }
    envelope.available = sum(beforeActivity, envelope.activity);
    const overspent = Math.max(0, -envelope.available);
    envelope.cashOverspent = Math.min(
      overspent,
      Math.max(0, sum(amounts.cash, -beforeActivity)),
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
    const value = result.categories[category.id];
    if (!category.isIncome) {
      result.totalAvailable = sum(result.totalAvailable, value.available);
      if (!paymentCategories.has(category.id)) {
        result.totalSpent = sum(result.totalSpent, value.activity);
      }
    }
  }
  result.autoBuffered = Math.max(
    0,
    sum(
      ...categories
        .filter(category => category.isIncome && category.carryover)
        .map(category => result.categories[category.id].activity),
    ),
  );
  result.buffered = buffered || result.autoBuffered;
  result.availableFunds = sum(
    result.income,
    result.fromLastMonth,
    result.creditAdjustments ?? 0,
  );
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
  return accountedCash === result.cashBalance
    ? result
    : { status: 'blocked', month, issues: [{ code: 'unbalanced-cash' }] };
}

function fundCreditSpending(
  spending: Spending,
  startingFunds: number,
): Map<string, number> {
  let funds = startingFunds;
  const funded = new Map<string, number>();
  const purchases: { accountId: string; amount: number; funded: number }[] = [];
  function change(accountId: string, amount: number) {
    funded.set(accountId, sum(funded.get(accountId) ?? 0, amount));
  }
  function allocate() {
    for (const purchase of purchases) {
      const amount = Math.min(
        Math.max(0, funds),
        sum(purchase.amount, -purchase.funded),
      );
      purchase.funded = sum(purchase.funded, amount);
      funds = sum(funds, -amount);
      change(purchase.accountId, amount);
    }
  }
  for (const event of spending.credit) {
    if (event.amount > 0) {
      purchases.push({ ...event, funded: 0 });
    } else {
      let refund = -event.amount;
      const matching = purchases
        .filter(purchase => purchase.accountId === event.accountId)
        .reverse();
      // Refund this card's purchases first. Without cash funding, a refund
      // can also cancel another card's unfunded spending in the same category.
      for (const purchase of matching) {
        const amount = Math.min(refund, sum(purchase.amount, -purchase.funded));
        purchase.amount = sum(purchase.amount, -amount);
        refund = sum(refund, -amount);
      }
      for (const purchase of matching) {
        const amount = Math.min(refund, purchase.funded);
        purchase.amount = sum(purchase.amount, -amount);
        purchase.funded = sum(purchase.funded, -amount);
        refund = sum(refund, -amount);
        funds = sum(funds, amount);
        change(event.accountId, -amount);
      }
      for (const purchase of purchases
        .filter(
          purchase =>
            startingFunds <= 0 && purchase.accountId !== event.accountId,
        )
        .reverse()) {
        const amount = Math.min(refund, sum(purchase.amount, -purchase.funded));
        purchase.amount = sum(purchase.amount, -amount);
        refund = sum(refund, -amount);
      }
      // Only the remaining refund releases cash from an existing reserve.
      funds = sum(funds, refund);
      change(event.accountId, -refund);
    }
    // Cash has priority. Remaining funds cover credit purchases in stable
    // transaction order, including several cards sharing an underfunded category.
    allocate();
  }
  return funded;
}
