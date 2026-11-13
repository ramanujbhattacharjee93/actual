import { describe, expect, it } from 'vitest';

import type {
  CreditCardBudgetConfig,
  CreditCardBudgetState,
} from '#shared/credit-card-budget';

import { calculateCreditCardMonth } from './credit-card-month';
import type {
  CreditCardMonthCategory,
  CreditCardMonthTransaction,
} from './credit-card-month';

const config: CreditCardBudgetConfig = {
  version: 2,
  cards: [
    { accountId: 'card', paymentCategoryId: 'payment' },
    { accountId: 'other-card', paymentCategoryId: 'other-payment' },
  ],
};

function tx(
  overrides: Partial<CreditCardMonthTransaction> & { id: string },
): CreditCardMonthTransaction {
  return {
    account: 'card',
    category: 'food',
    amount: -6000,
    date: 20170110,
    is_parent: 0,
    is_child: 0,
    parent_id: null,
    starting_balance_flag: 0,
    error: null,
    transfer_id: null,
    transfer_account: null,
    transfer_amount: null,
    transfer_date: null,
    transfer_back: null,
    transfer_offbudget: null,
    ...overrides,
  };
}

function transfer(
  from = 'cash',
  to = 'card',
  amount = 5000,
  fromDate = 20170120,
  toDate = fromDate,
) {
  return [
    tx({
      id: 'transfer-from',
      account: from,
      category: null,
      amount: -amount,
      date: fromDate,
      transfer_id: 'transfer-to',
      transfer_account: to,
      transfer_amount: amount,
      transfer_date: toDate,
      transfer_back: 'transfer-from',
      transfer_offbudget: 0,
    }),
    tx({
      id: 'transfer-to',
      account: to,
      category: null,
      amount,
      date: toDate,
      transfer_id: 'transfer-from',
      transfer_account: from,
      transfer_amount: -amount,
      transfer_date: fromDate,
      transfer_back: 'transfer-to',
      transfer_offbudget: 0,
    }),
  ];
}

function calculate({
  transactions = [],
  food = 0,
  payment = 0,
  openingCard = -20000,
  previous,
  month = '2017-01',
  extraCategories = [],
  mode = config,
}: {
  transactions?: CreditCardMonthTransaction[];
  food?: number;
  payment?: number;
  openingCard?: number;
  previous?: CreditCardBudgetState;
  month?: string;
  extraCategories?: CreditCardMonthCategory[];
  mode?: CreditCardBudgetConfig;
} = {}) {
  const result = calculateCreditCardMonth({
    month,
    config: mode,
    buffered: 0,
    previous,
    categories: [
      { id: 'income', isIncome: true, assigned: 0, carryover: false },
      { id: 'food', isIncome: false, assigned: food, carryover: false },
      { id: 'payment', isIncome: false, assigned: payment, carryover: false },
      { id: 'other-payment', isIncome: false, assigned: 0, carryover: false },
      ...extraCategories,
    ],
    transactions: [
      ...(!previous
        ? [
            tx({
              id: 'cash-opening',
              account: 'cash',
              category: 'income',
              amount: 100000,
              date: 20170101,
              starting_balance_flag: 1,
            }),
            tx({
              id: 'card-opening',
              category: 'income',
              amount: openingCard,
              date: 20170101,
              starting_balance_flag: 1,
            }),
          ]
        : []),
      ...transactions,
    ],
  });
  if (result.status !== 'ready') {
    throw new Error(JSON.stringify(result));
  }
  expect(
    result.toBudget +
      result.buffered +
      result.totalAvailable +
      Object.values(result.categories).reduce(
        (total, category) => total + category.creditOverspent,
        0,
      ),
  ).toBe(result.cashBalance);
  return result;
}

describe('native credit-card accounting', () => {
  it('does not show payment amounts while a reciprocal transfer is missing its date', () => {
    const result = calculateCreditCardMonth({
      month: '2017-01',
      config,
      buffered: 0,
      categories: [
        { id: 'payment', isIncome: false, assigned: 5000, carryover: false },
        { id: 'other-payment', isIncome: false, assigned: 0, carryover: false },
      ],
      transactions: [{ ...transfer()[0], transfer_date: null }],
    });
    expect(result).toMatchObject({
      status: 'blocked',
      issues: [
        { code: 'unsupported-transfer', transactionId: 'transfer-from' },
      ],
    });
    expect(result).not.toHaveProperty('cards');
  });
  it('reserves purchases once and consumes the reserve for payments', () => {
    const result = calculate({
      food: 10000,
      payment: 5000,
      transactions: [tx({ id: 'purchase' }), ...transfer('cash', 'card', 8000)],
    });
    expect(result).toMatchObject({
      toBudget: 85000,
      totalSpent: -6000,
      cashBalance: 92000,
      cards: [{ balance: -18000, paymentAvailable: 3000, payments: 8000 }, {}],
    });
  });

  it('spends a positive card balance as cash and reserves only newly borrowed funds', () => {
    const result = calculate({
      openingCard: 5000,
      food: 8000,
      transactions: [tx({ id: 'purchase', amount: -8000 })],
    });
    expect(result).toMatchObject({
      income: 105000,
      toBudget: 97000,
      cashBalance: 100000,
      cards: [
        { balance: -3000, fundedSpending: 3000, paymentAvailable: 3000 },
        {},
      ],
    });
  });

  it('treats overspending against a positive balance as cash overspending', () => {
    const result = calculate({
      openingCard: 5000,
      transactions: [tx({ id: 'purchase', amount: -8000 })],
    });
    expect(result.categories.food).toMatchObject({
      available: -8000,
      cashOverspent: 5000,
      creditOverspent: 3000,
    });
    const next = calculate({ previous: result, month: '2017-02' });
    expect(next.lastMonthOverspent).toBe(-5000);
    expect(next.toBudget).toBe(100000);
  });

  it('puts only the positive part of a statement credit into available cash', () => {
    const result = calculate({
      transactions: [tx({ id: 'reward', category: 'income', amount: 25000 })],
    });
    expect(result).toMatchObject({
      income: 105000,
      toBudget: 105000,
      cashBalance: 105000,
      cards: [{ balance: 5000, paymentAvailable: 0 }, {}],
    });
  });

  it('returns a refund to its category without reserving positive card cash', () => {
    const result = calculate({
      transactions: [tx({ id: 'refund', amount: 25000 })],
    });
    expect(result).toMatchObject({
      income: 100000,
      toBudget: 100000,
      cashBalance: 105000,
      categories: { food: { available: 25000 } },
      cards: [
        { balance: 5000, paymentAvailable: -20000, paymentShortfall: 20000 },
        {},
      ],
    });
  });

  it.each([
    { food: 0, refund: 2000, fundedSpending: 0 },
    { food: -3000, refund: 5000, fundedSpending: -3000 },
  ])(
    'nets a cross-card refund against unfunded spending with $food assigned',
    ({ food, refund, fundedSpending }) => {
      const result = calculate({
        food,
        payment: 5000,
        transactions: [
          tx({
            id: 'other-opening',
            account: 'other-card',
            category: 'income',
            amount: -20000,
            date: 20170101,
            starting_balance_flag: 1,
          }),
          tx({ id: 'purchase', account: 'other-card', amount: -2000 }),
          tx({ id: 'refund', amount: refund, date: 20170120 }),
        ],
      });
      expect(result.categories.food.available).toBe(0);
      expect(result.cards).toMatchObject([
        { fundedSpending, paymentAvailable: 5000 + fundedSpending },
        { fundedSpending: 0, paymentAvailable: 0 },
      ]);
    },
  );

  it('reverses the receiving reserve when cash-funded spending is refunded to another card', () => {
    const result = calculate({
      food: 5000,
      payment: 5000,
      transactions: [
        tx({
          id: 'other-opening',
          account: 'other-card',
          category: 'income',
          amount: -20000,
          date: 20170101,
          starting_balance_flag: 1,
        }),
        tx({ id: 'purchase', account: 'other-card', amount: -10000 }),
        tx({ id: 'refund', amount: 5000, date: 20170120 }),
      ],
    });
    expect(result.cards).toMatchObject([
      { fundedSpending: -5000, paymentAvailable: 0 },
      { fundedSpending: 10000, paymentAvailable: 10000 },
    ]);
  });

  it('conserves cash when a cross-card refund offsets mixed cash and credit overspending', () => {
    const result = calculate({
      payment: 5000,
      transactions: [
        tx({
          id: 'other-opening',
          account: 'other-card',
          category: 'income',
          amount: -20000,
          date: 20170101,
          starting_balance_flag: 1,
        }),
        tx({ id: 'cash-spending', account: 'cash', amount: -10000 }),
        tx({ id: 'purchase', account: 'other-card', amount: -2000 }),
        tx({ id: 'refund', amount: 5000, date: 20170120 }),
      ],
    });
    expect(result.categories.food).toMatchObject({
      available: -7000,
      cashOverspent: 7000,
      creditOverspent: 0,
    });
    expect(result.cards).toMatchObject([
      { fundedSpending: -3000, paymentAvailable: 2000 },
      { fundedSpending: 0, paymentAvailable: 0 },
    ]);
    expect(result.cashBalance).toBe(90000);
  });

  it('adds cash advances to assignable cash without funding payment reserves', () => {
    const result = calculate({ transactions: transfer('card', 'cash', 6000) });
    expect(result).toMatchObject({
      toBudget: 106000,
      creditAdjustments: 6000,
      cashBalance: 106000,
      cards: [{ balance: -26000, paymentAvailable: 0 }, {}],
    });
  });

  it('does not move reserves automatically between cards during a balance transfer', () => {
    const result = calculate({
      payment: 20000,
      transactions: transfer('other-card', 'card', 20000),
    });
    expect(result.cards).toMatchObject([
      { balance: 0, paymentAvailable: 20000, excessReserve: 20000 },
      { balance: -20000, paymentAvailable: 0, unfundedDebt: 20000 },
    ]);
    expect(result.creditAdjustments).toBe(0);
  });

  it('handles overpayments without creating or losing cash', () => {
    const result = calculate({
      payment: 20000,
      transactions: transfer('cash', 'card', 25000),
    });
    expect(result).toMatchObject({
      toBudget: 85000,
      creditAdjustments: 5000,
      cashBalance: 80000,
      cards: [
        { balance: 5000, paymentAvailable: -5000, paymentShortfall: 5000 },
        {},
      ],
    });
  });

  it('funds several cards in stable chronological order when a category is short', () => {
    const transactions = [
      tx({ id: 'first', date: 20170110 }),
      tx({ id: 'second', account: 'other-card', date: 20170111 }),
    ];
    const result = calculate({ food: 10000, transactions });
    expect(result.cards.map(card => card.paymentAvailable)).toEqual([
      6000, 4000,
    ]);
    expect(result.categories.food.creditOverspent).toBe(2000);
    expect(
      calculate({ food: 10000, transactions: [...transactions].reverse() }),
    ).toEqual(result);
  });

  it('covers cash spending before card spending regardless of transaction dates', () => {
    const result = calculate({
      food: 10000,
      transactions: [
        tx({ id: 'first' }),
        tx({ id: 'second', account: 'other-card', date: 20170111 }),
        tx({ id: 'cash', account: 'cash', amount: -8000, date: 20170130 }),
      ],
    });
    expect(result.cards.map(card => card.paymentAvailable)).toEqual([2000, 0]);
    expect(result.categories.food).toMatchObject({
      cashOverspent: 0,
      creditOverspent: 10000,
    });
  });

  it('uses a prior-month refund to fund a later purchase on another card', () => {
    const previous = calculate({
      food: 6000,
      transactions: [tx({ id: 'purchase' })],
    });
    const result = calculate({
      previous,
      month: '2017-02',
      transactions: [
        tx({ id: 'refund', amount: 6000, date: 20170201 }),
        tx({ id: 'new-purchase', account: 'other-card', date: 20170202 }),
      ],
    });
    expect(result.cards.map(card => card.paymentAvailable)).toEqual([0, 6000]);
    expect(result.categories.food.available).toBe(0);
  });

  it('consumes payment reserves on the source date when posting dates cross a month boundary', () => {
    const pair = transfer('cash', 'card', 3000, 20170131, 20170201);
    const previous = calculate({ payment: 5000, transactions: [pair[0]] });
    expect(previous.cards[0]).toMatchObject({
      balance: -20000,
      paymentAvailable: 2000,
    });
    const result = calculate({
      previous,
      month: '2017-02',
      transactions: [pair[1]],
    });
    expect(result.cards[0]).toMatchObject({
      balance: -17000,
      paymentAvailable: 2000,
      payments: 0,
    });
    expect(result.cashBalance).toBe(97000);
  });

  it('handles split payments and purchases without counting parents twice', () => {
    const pair = transfer('cash', 'card', 5000);
    const result = calculate({
      food: 4000,
      payment: 5000,
      transactions: [
        tx({
          id: 'parent',
          account: 'cash',
          category: null,
          amount: -9000,
          date: 20170120,
          is_parent: 1,
        }),
        { ...pair[0], is_child: 1, parent_id: 'parent' },
        tx({
          id: 'food-child',
          account: 'cash',
          amount: -4000,
          date: 20170120,
          is_child: 1,
          parent_id: 'parent',
        }),
        pair[1],
      ],
    });
    expect(result).toMatchObject({
      cashBalance: 91000,
      toBudget: 91000,
      totalSpent: -4000,
      cards: [{ balance: -15000, payments: 5000, paymentAvailable: 0 }, {}],
    });
  });

  it('keeps built-in debt-only interest separate from funded interest expenses', () => {
    const result = calculate({
      mode: { ...config, debtCategoryIds: ['interest'] },
      extraCategories: [
        { id: 'interest', assigned: 0, isIncome: false, carryover: false },
      ],
      transactions: [
        tx({ id: 'interest', category: 'interest', amount: -2000 }),
      ],
    });
    expect(result).toMatchObject({
      toBudget: 100000,
      totalSpent: 0,
      cards: [
        { balance: -22000, interestCharged: 2000, paymentAvailable: 0 },
        {},
      ],
    });
    const funded = calculate({
      food: 2000,
      transactions: [tx({ id: 'fee', amount: -2000 })],
    });
    expect(funded.cards[0].paymentAvailable).toBe(2000);
    expect(funded.totalSpent).toBe(-2000);
  });

  it('still blocks malformed split data rather than publishing partial amounts', () => {
    const result = calculateCreditCardMonth({
      month: '2017-01',
      config,
      categories: [],
      buffered: 0,
      transactions: [
        tx({ id: 'parent', category: null, is_parent: 1 }),
        tx({ id: 'child', is_child: 1, parent_id: 'parent', amount: -1000 }),
      ],
    });
    expect(result).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([
        { code: 'invalid-split', transactionId: 'parent' },
      ]),
    });
    expect(result).not.toHaveProperty('cards');
  });
});
