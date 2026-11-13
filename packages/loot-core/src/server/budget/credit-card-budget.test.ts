import { Timestamp } from '@actual-app/crdt';
import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import * as sheet from '#server/sheet';
import { applyMessages } from '#server/sync';
import type { Message } from '#server/sync';
import { redo, undo } from '#server/undo';
import {
  CREDIT_CARD_BUDGET_PREF,
  parseCreditCardBudgetConfig,
} from '#shared/credit-card-budget';
import type { CreditCardBudgetConfig } from '#shared/credit-card-budget';

import { setBudget } from './actions';
import { app } from './app';
import { createBudget } from './base';
import {
  BLOCKED_BUDGET_VALUE,
  enableCreditCardBudget,
  getCreditCardBudgetState,
} from './credit-card-budget';

let config: CreditCardBudgetConfig;

function message(value: Omit<Message, 'timestamp'>): Message {
  const timestamp = Timestamp.send();
  if (!timestamp) {
    throw new Error('Missing fixture timestamp');
  }
  return { ...value, timestamp };
}

async function setup({ enable = true } = {}) {
  await global.emptyDatabase()();
  await db.insertCategoryGroup({ id: 'income', name: 'Income', is_income: 1 });
  await db.insertCategory({
    id: 'income',
    name: 'Income',
    cat_group: 'income',
    is_income: 1,
  });
  await db.insertCategoryGroup({ id: 'expenses', name: 'Expenses' });
  await db.insertCategory({
    id: 'food',
    name: 'Food',
    cat_group: 'expenses',
  });
  await db.insertCategory({
    id: 'fees',
    name: 'Fees',
    cat_group: 'expenses',
  });
  await db.insertAccount({ id: 'cash', name: 'Cash' });
  await db.insertAccount({ id: 'card', name: 'Card' });
  await db.insertAccount({ id: 'card2', name: 'Other card' });
  await db.insertTransaction({
    id: 'opening-cash',
    account: 'cash',
    category: 'income',
    amount: 100000,
    date: '2017-01-01',
    starting_balance_flag: true,
  });
  await db.insertTransaction({
    id: 'opening-card',
    account: 'card',
    category: 'income',
    amount: -20000,
    date: '2017-01-01',
    starting_balance_flag: true,
  });
  await sheet.loadSpreadsheet(db);
  await createBudget(['2016-12', '2017-01', '2017-02', '2017-03']);
  if (enable) {
    config = await enableCreditCardBudget({
      accountIds: ['card', 'card2'],
      paymentGroupName: 'Credit Card Payments',
      forkOnlyAcknowledged: true,
    });
    config.version = 1;
    await db.update('preferences', {
      id: CREDIT_CARD_BUDGET_PREF,
      value: JSON.stringify(config),
    });
  }
}

function paymentCategory(accountId = 'card') {
  const card = config.cards.find(card => card.accountId === accountId);
  if (!card) {
    throw new Error('Missing fixture card');
  }
  return card.paymentCategoryId;
}

async function assign(category: string, amount: number, month = '2017-01') {
  await setBudget({ category, amount, month });
}

async function transaction({
  id = 'purchase',
  account = 'card',
  category = 'food',
  amount = -6000,
  date = '2017-01-10',
} = {}) {
  await db.insertTransaction({ id, account, category, amount, date });
}

async function payment(amount = 8000, date = '2017-01-20') {
  await db.insertTransaction({
    id: 'payment-card',
    account: 'card',
    amount,
    date,
    transfer_id: 'payment-cash',
  });
  await db.insertTransaction({
    id: 'payment-cash',
    account: 'cash',
    amount: -amount,
    date,
    transfer_id: 'payment-card',
  });
}

async function ready(month = '2017-01') {
  const state = await getCreditCardBudgetState({ month });
  if (state?.status !== 'ready') {
    throw new Error(`Unexpected state: ${JSON.stringify(state)}`);
  }
  return state;
}

async function expectCashConserved(month = '2017-01') {
  const state = await ready(month);
  const endDate = Number(`${month.replace('-', '')}31`);
  const cash = db.firstSync<{ amount: number }>(
    `SELECT SUM(amount) AS amount FROM v_transactions_internal_alive
      WHERE account = 'cash' AND is_child = 0 AND date <= ?`,
    [endDate],
  )?.amount;
  expect(
    state.toBudget +
      state.buffered +
      state.totalAvailable +
      Object.values(state.categories).reduce(
        (total, category) => total + category.creditOverspent,
        0,
      ),
  ).toBe(cash);
}

describe('opt-in credit-card budgeting', () => {
  beforeEach(() => setup());

  it('creates stable synced mappings and excludes opening debt from cash', async () => {
    const stored = db.firstSync<db.DbPreference>(
      'SELECT * FROM preferences WHERE id = ?',
      [CREDIT_CARD_BUDGET_PREF],
    );
    expect(parseCreditCardBudgetConfig(stored?.value ?? '')).toEqual(config);
    expect(await ready()).toMatchObject({
      income: 100000,
      toBudget: 100000,
      cards: [
        { balance: -20000, paymentAvailable: 0, unfundedDebt: 20000 },
        { balance: 0, paymentAvailable: 0 },
      ],
    });
    expect(sheet.getCellValue('budget201701', 'to-budget')).toBe(100000);
    await expectCashConserved();
  });

  it('reserves purchases once and reduces reserves for actual transfer payments', async () => {
    await assign('food', 10000);
    await assign(paymentCategory(), 5000);
    await transaction();
    await payment();

    expect(await ready()).toMatchObject({
      toBudget: 85000,
      totalSpent: -6000,
      categories: {
        food: { available: 4000, activity: -6000 },
        [paymentCategory()]: { available: 3000, activity: -2000 },
      },
      cards: [
        {
          balance: -18000,
          fundedSpending: 6000,
          payments: 8000,
          paymentAvailable: 3000,
          unfundedDebt: 15000,
        },
        {},
      ],
    });
    expect(
      sheet.getCellValue('budget201701', `leftover-${paymentCategory()}`),
    ).toBe(3000);
    await expectCashConserved();
  });

  it('rolls credit overspending into debt without subtracting it from next month cash', async () => {
    await assign('food', 3000);
    await transaction({ amount: -6000 });
    expect((await ready()).categories.food).toMatchObject({
      available: -3000,
      cashOverspent: 0,
      creditOverspent: 3000,
    });
    expect(await ready('2017-02')).toMatchObject({
      toBudget: 97000,
      lastMonthOverspent: 0,
      categories: { food: { available: 0 } },
      cards: [{ paymentAvailable: 3000, unfundedDebt: 23000 }, {}],
    });
    await expectCashConserved();
    await expectCashConserved('2017-02');
  });

  it('prioritizes cash spending and charges only the cash shortfall next month', async () => {
    await assign('food', 3000);
    await transaction({ amount: -6000 });
    await transaction({ id: 'cash-food', account: 'cash', amount: -5000 });
    expect((await ready()).categories.food).toMatchObject({
      available: -8000,
      cashOverspent: 2000,
      creditOverspent: 6000,
    });
    expect(await ready('2017-02')).toMatchObject({
      toBudget: 95000,
      lastMonthOverspent: -2000,
      cards: [{ paymentAvailable: 0 }, {}],
    });
    await expectCashConserved();
    await expectCashConserved('2017-02');
  });

  it('reverses reserves for a later-month refund and preserves a negative payment envelope', async () => {
    await assign('food', 6000);
    await transaction();
    await payment(6000);
    await transaction({
      id: 'refund',
      amount: 4000,
      date: '2017-02-05',
    });
    expect(await ready('2017-02')).toMatchObject({
      categories: { food: { available: 4000 } },
      cards: [
        { balance: -16000, paymentAvailable: -4000, paymentShortfall: 4000 },
        {},
      ],
    });
    await expectCashConserved('2017-02');
    await assign('food', -4000, '2017-02');
    await assign(paymentCategory(), 4000, '2017-02');
    expect((await ready('2017-02')).cards[0].paymentAvailable).toBe(0);
    await expectCashConserved('2017-02');
    await expectCashConserved('2017-03');
  });

  it('nets same-month refunds without reserving unfunded spending', async () => {
    await transaction({ amount: -10000 });
    await transaction({ id: 'refund', amount: 6000 });
    expect((await ready()).cards[0].paymentAvailable).toBe(0);
    await assign('food', 4000);
    expect((await ready()).cards[0].paymentAvailable).toBe(4000);
    await expectCashConserved();
  });

  it('does not turn a statement credit into cash and exposes excess reserves', async () => {
    await assign(paymentCategory(), 20000);
    await transaction({ id: 'reward', category: 'income', amount: 5000 });
    expect(await ready()).toMatchObject({
      income: 100000,
      toBudget: 80000,
      cards: [
        { balance: -15000, paymentAvailable: 20000, excessReserve: 5000 },
        {},
      ],
    });
    await expectCashConserved();
  });

  it('funds multiple cards exactly but blocks ambiguous underfunding until corrected', async () => {
    await assign('food', 10000);
    await transaction({ amount: -6000 });
    await transaction({
      id: 'other-purchase',
      account: 'card2',
      amount: -4000,
    });
    expect((await ready()).cards.map(card => card.paymentAvailable)).toEqual([
      6000, 4000,
    ]);

    await assign('food', 8000);
    expect(await getCreditCardBudgetState({ month: '2017-01' })).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'ambiguous-card-funding', categoryId: 'food' }],
    });
    expect(sheet.getCellValue('budget201701', 'to-budget')).toBe(
      BLOCKED_BUDGET_VALUE,
    );
    await expect(
      app.handlers['envelope-budget-month']({ month: '2017-01' }),
    ).rejects.toThrow('blocked');
    expect(await getCreditCardBudgetState({ month: '2017-02' })).toMatchObject({
      status: 'blocked',
      month: '2017-01',
    });
    await assign('food', 10000);
    expect(
      (await ready('2017-02')).cards.map(card => card.paymentAvailable),
    ).toEqual([6000, 4000]);
    await expectCashConserved('2017-02');
  });

  it('recomputes history after edits, deletion, and received CRDT messages', async () => {
    await assign('food', 10000);
    await transaction();
    expect((await ready('2017-02')).cards[0].paymentAvailable).toBe(6000);

    await db.updateTransaction({ id: 'purchase', amount: -4000 });
    expect((await ready('2017-02')).cards[0].paymentAvailable).toBe(4000);
    await applyMessages([
      message({
        dataset: 'transactions',
        row: 'purchase',
        column: 'amount',
        value: -2000,
      }),
    ]);
    expect((await ready('2017-02')).cards[0].paymentAvailable).toBe(2000);
    await db.deleteTransaction({ id: 'purchase' });
    expect((await ready('2017-02')).cards[0].paymentAvailable).toBe(0);
    await expectCashConserved('2017-02');
  });

  it('recomputes later reserves after allocation undo and redo', async () => {
    await transaction();
    await runHandler(handlers['budget/budget-amount'], {
      month: '2017-01',
      category: 'food',
      amount: 6000,
    });
    expect((await ready('2017-02')).cards[0].paymentAvailable).toBe(6000);
    await undo();
    expect((await ready('2017-02')).cards[0].paymentAvailable).toBe(0);
    await redo();
    expect((await ready('2017-02')).cards[0].paymentAvailable).toBe(6000);
    await expectCashConserved('2017-02');
  });

  it('preserves mode calculations when the budget cache is reset', async () => {
    await assign('food', 10000);
    await transaction();
    const before = await ready('2017-02');
    await runHandler(handlers['reset-budget-cache']);
    expect(await ready('2017-02')).toEqual(before);
    expect(sheet.getCellValue('budget201701', 'sum-amount-income')).toBe(
      100000,
    );
    expect(
      sheet.getCellValue('budget201701', `sum-amount-${paymentCategory()}`),
    ).toBe(6000);
  });

  it('deducts a real payment shortfall at rollover without carrying a negative reserve', async () => {
    await payment(5000);
    expect((await ready()).cards[0].paymentShortfall).toBe(5000);
    expect(await ready('2017-02')).toMatchObject({
      toBudget: 95000,
      lastMonthOverspent: -5000,
      cards: [{ paymentAvailable: 0 }, {}],
    });
    await expectCashConserved();
    await expectCashConserved('2017-02');
  });

  it('keeps held funds and future allocations separate from current spending', async () => {
    await assign('food', 10000, '2017-02');
    await db.insert('zero_budget_months', {
      id: '2017-01',
      buffered: 20000,
    });
    expect(await ready()).toMatchObject({ toBudget: 80000, buffered: 20000 });
    expect(await ready('2017-02')).toMatchObject({
      fromLastMonth: 100000,
      toBudget: 90000,
      categories: { food: { available: 10000 } },
    });
    await expectCashConserved();
    await expectCashConserved('2017-02');
  });

  it.each([0.5, Number.MAX_SAFE_INTEGER + 1])(
    'blocks invalid persisted monetary input %s',
    async amount => {
      await assign('food', 1000);
      await db.update('zero_budgets', {
        id: '201701-food',
        amount,
      });
      expect(
        await getCreditCardBudgetState({ month: '2017-01' }),
      ).toMatchObject({
        status: 'blocked',
        issues: [{ code: 'invalid-amount' }],
      });
    },
  );

  it('counts split parents for balances and children for category funding', async () => {
    await assign('food', 6000);
    await assign('fees', 4000);
    await db.insertTransaction({
      id: 'split',
      account: 'card',
      amount: -10000,
      date: '2017-01-10',
      is_parent: true,
    });
    for (const [id, category, amount] of [
      ['child-food', 'food', -6000],
      ['child-fees', 'fees', -4000],
    ] as const) {
      await db.insertTransaction({
        id,
        account: 'card',
        amount,
        category,
        date: '2017-01-10',
        is_child: true,
        parent_id: 'split',
      });
    }
    expect((await ready()).cards[0]).toMatchObject({
      balance: -30000,
      paymentAvailable: 10000,
    });
    await expectCashConserved();

    await db.updateTransaction({ id: 'child-fees', amount: -3000 });
    expect(await getCreditCardBudgetState({ month: '2017-01' })).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([
        { code: 'invalid-split', transactionId: 'split' },
      ]),
    });
  });

  it('refreshes after category creation, moves, and account eligibility changes', async () => {
    await db.insertCategory({ id: 'new', name: 'New', cat_group: 'expenses' });
    await assign('new', 1000);
    await transaction({ category: 'new', amount: -1000 });
    expect((await ready()).cards[0].paymentAvailable).toBe(1000);
    await db.insertCategoryGroup({ id: 'other', name: 'Other' });
    await db.updateCategory({
      id: 'new',
      name: 'New',
      is_income: 0,
      cat_group: 'other',
    });
    await sheet.waitOnSpreadsheet();
    expect(sheet.getCellValue('budget201701', 'group-leftover-other')).toBe(0);
    expect(sheet.getCellValue('budget201701', 'group-budget-other')).toBe(1000);

    await db.updateAccount({ id: 'card', offbudget: 1 });
    expect(await getCreditCardBudgetState({ month: '2017-01' })).toMatchObject({
      status: 'blocked',
      issues: [
        {
          code: 'invalid-mapping',
          accountId: 'card',
          categoryId: paymentCategory(),
        },
      ],
    });
  });

  it.each([
    [
      'positive balance',
      async () => transaction({ category: 'income', amount: 25000 }),
      'positive-card-balance',
    ],
    ['cash advance', async () => payment(-1000), 'unsupported-transfer'],
    [
      'uncategorized spending',
      async () =>
        db.insertTransaction({
          id: 'unknown',
          account: 'cash',
          amount: -1000,
          date: '2017-01-10',
        }),
      'uncategorized-spending',
    ],
    [
      'categorized payment',
      async () => transaction({ category: paymentCategory() }),
      'payment-category-transaction',
    ],
    [
      'carryover override',
      async () =>
        db.insert('zero_budgets', {
          id: 'carry',
          month: 201701,
          category: 'food',
          carryover: 1,
          amount: 0,
        }),
      'unsupported-carryover',
    ],
  ] as const)(
    'fails closed for %s without returning calculated amounts',
    async (_name, change, code) => {
      await change();
      const state = await getCreditCardBudgetState({ month: '2017-01' });
      expect(state).toMatchObject({
        status: 'blocked',
        issues: expect.arrayContaining([expect.objectContaining({ code })]),
      });
      expect(state).not.toHaveProperty('cards');
      expect(state).not.toHaveProperty('toBudget');
    },
  );

  it('survives reopening without changing accounting and never persists calculated transfers', async () => {
    await assign('food', 10000);
    await transaction();
    const before = await ready('2017-02');
    const rows = await db.all('SELECT * FROM transactions ORDER BY id');
    sheet.unloadSpreadsheet();
    await sheet.loadSpreadsheet(db);
    await createBudget(['2016-12', '2017-01', '2017-02']);
    expect(await ready('2017-02')).toEqual(before);
    expect(await db.all('SELECT * FROM transactions ORDER BY id')).toEqual(
      rows,
    );
  });

  it('rejects generic mode edits and budget-type conversion', async () => {
    for (const pref of [
      { id: CREDIT_CARD_BUDGET_PREF, value: '' },
      { id: 'budgetType', value: 'tracking' },
    ] as const) {
      await expect(handlers['preferences/save'](pref)).rejects.toThrow(
        'dedicated setup',
      );
    }
  });

  it('fails closed when an incompatible configuration arrives through sync', async () => {
    await applyMessages([
      message({
        dataset: 'preferences',
        row: CREDIT_CARD_BUDGET_PREF,
        column: 'value',
        value: '{"version":99,"cards":[]}',
      }),
    ]);
    expect(await getCreditCardBudgetState({ month: '2017-01' })).toMatchObject({
      status: 'blocked',
      issues: [{ code: 'invalid-configuration' }],
    });
  });
});

describe('credit-card enablement boundary', () => {
  beforeEach(() => setup({ enable: false }));

  const request = {
    accountIds: ['card'],
    paymentGroupName: 'Credit Card Payments',
    forkOnlyAcknowledged: true,
  };

  it('leaves ordinary Actual accounting unchanged when disabled', async () => {
    await assign('food', 3000);
    await transaction();
    await sheet.waitOnSpreadsheet();
    expect(await getCreditCardBudgetState({ month: '2017-01' })).toBeNull();
    expect(sheet.getCellValue('budget201701', 'to-budget')).toBe(77000);
    expect(sheet.getCellValue('budget201702', 'last-month-overspent')).toBe(
      -3000,
    );
    expect(sheet.getCellValue('budget201702', 'to-budget')).toBe(74000);
  });

  it('rejects enablement for an existing budget without writing mappings or categories', async () => {
    await transaction();
    const categories = await db.all('SELECT * FROM categories ORDER BY id');
    await expect(enableCreditCardBudget(request)).rejects.toThrow('new budget');
    expect(await db.all('SELECT * FROM categories ORDER BY id')).toEqual(
      categories,
    );
    expect(await getCreditCardBudgetState({ month: '2017-01' })).toBeNull();
  });

  it('requires acknowledgement and distinct eligible accounts', async () => {
    await expect(
      enableCreditCardBudget({ ...request, forkOnlyAcknowledged: false }),
    ).rejects.toThrow('Acknowledge');
    await expect(
      enableCreditCardBudget({ ...request, accountIds: ['card', 'card'] }),
    ).rejects.toThrow('distinct');
    await db.updateAccount({ id: 'card', offbudget: 1 });
    await expect(enableCreditCardBudget(request)).rejects.toThrow('on-budget');
  });

  it('builds the same mode when a valid configuration is received by another client', async () => {
    await db.insertCategoryGroup({ id: 'payments', name: 'Payments' });
    await db.insertCategory({
      id: 'card-payment',
      name: 'Card',
      cat_group: 'payments',
    });
    await applyMessages([
      message({
        dataset: 'preferences',
        row: CREDIT_CARD_BUDGET_PREF,
        column: 'value',
        value: JSON.stringify({
          version: 1,
          cards: [{ accountId: 'card', paymentCategoryId: 'card-payment' }],
        }),
      }),
    ]);
    await assign('food', 6000);
    await transaction();
    expect((await ready()).cards[0].paymentAvailable).toBe(6000);
    expect(sheet.getCellValue('budget201701', 'to-budget')).toBe(94000);
  });
});
