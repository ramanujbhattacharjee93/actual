import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import * as sheet from '#server/sheet';

import { setBudget } from './actions';
import { app } from './app';
import { createBudget, setType } from './base';
import { previewCreditCardReserves } from './credit-card-preview';

const request = {
  month: '2024-01',
  cards: [{ accountId: 'card', openingPaymentAvailable: 0, assigned: 0 }],
};

async function purchase({
  id = 'purchase',
  amount = -10000,
  account = 'card',
  category = 'groceries',
  date = '2024-01-10',
} = {}) {
  return db.insertTransaction({ id, amount, account, category, date });
}

async function payment(amount = 5000) {
  await db.insertTransaction({
    id: 'payment-card',
    account: 'card',
    amount,
    transfer_id: 'payment-cash',
    date: '2024-01-20',
  });
  await db.insertTransaction({
    id: 'payment-cash',
    account: 'cash',
    amount: -amount,
    transfer_id: 'payment-card',
    date: '2024-01-20',
  });
}

async function getPreview(params = request) {
  const result = await previewCreditCardReserves(params);
  if (result.status !== 'preview') {
    throw new Error(
      `Unexpected blocked preview: ${JSON.stringify(result.issues)}`,
    );
  }
  return result;
}

describe('read-only credit-card budget preview', () => {
  beforeEach(async () => {
    await global.emptyDatabase()();
    await db.insertCategoryGroup({
      id: 'income',
      name: 'Income',
      is_income: 1,
    });
    await db.insertCategory({
      id: 'income',
      name: 'Income',
      cat_group: 'income',
      is_income: 1,
    });
    await db.insertCategoryGroup({ id: 'expenses', name: 'Expenses' });
    await db.insertCategory({
      id: 'groceries',
      name: 'Groceries',
      cat_group: 'expenses',
    });
    await db.insertCategory({
      id: 'fees',
      name: 'Fees',
      cat_group: 'expenses',
    });
    await db.insertAccount({ id: 'cash', name: 'Cash' });
    await db.insertAccount({ id: 'card', name: 'Card' });
    await db.insertTransaction({
      id: 'opening-cash',
      account: 'cash',
      category: 'income',
      amount: 100000,
      date: '2023-12-01',
      starting_balance_flag: true,
    });
    await db.insertTransaction({
      id: 'opening-card',
      account: 'card',
      category: 'income',
      amount: -20000,
      date: '2023-12-01',
      starting_balance_flag: true,
    });
    await sheet.loadSpreadsheet(db);
    await createBudget(['2023-12', '2024-01', '2024-02']);
    await setBudget({ category: 'groceries', month: '2024-01', amount: 10000 });
    await sheet.waitOnSpreadsheet();
  });

  it('exposes an explicit preview handler without changing budget data or totals', async () => {
    await purchase();
    await payment();
    await sheet.waitOnSpreadsheet();
    const tables = [
      'accounts',
      'transactions',
      'zero_budgets',
      'zero_budget_months',
      'preferences',
      'messages_crdt',
    ];
    function readBudgetData() {
      return tables.map(table =>
        db.runQuery<Record<string, unknown>>(
          `SELECT * FROM ${table} ORDER BY id`,
          [],
          true,
        ),
      );
    }
    const before = readBudgetData();
    const toBudget = sheet.getCellValue('budget202401', 'to-budget');

    const result = await app.handlers['budget/preview-credit-card-reserves']({
      ...request,
      cards: [
        { accountId: 'card', openingPaymentAvailable: 5000, assigned: 2000 },
      ],
    });

    expect(result).toMatchObject({
      status: 'preview',
      cards: [
        {
          balance: -25000,
          fundedSpending: 10000,
          paymentAvailable: 12000,
          unfundedDebt: 13000,
        },
      ],
    });
    expect(readBudgetData()).toEqual(before);
    expect(sheet.getCellValue('budget202401', 'to-budget')).toBe(toBudget);
    expect(sheet.getCellValue('budget202401', 'sum-amount-groceries')).toBe(
      -10000,
    );
  });

  it('recomputes after historical transaction edits, rebudgeting, and deletion', async () => {
    await purchase();
    expect((await getPreview()).cards[0].paymentAvailable).toBe(10000);

    await db.updateTransaction({ id: 'purchase', amount: -6000 });
    expect((await getPreview()).cards[0].paymentAvailable).toBe(6000);

    await setBudget({ category: 'groceries', month: '2024-01', amount: 3000 });
    expect((await getPreview()).cards[0].paymentAvailable).toBe(3000);

    await db.deleteTransaction({ id: 'purchase' });
    expect((await getPreview()).cards[0].paymentAvailable).toBe(0);
  });

  it('covers actual cash spending before reserving category funds for a card', async () => {
    await purchase({ amount: -6000 });
    await purchase({ id: 'cash-purchase', account: 'cash', amount: -8000 });

    expect((await getPreview()).cards[0]).toMatchObject({
      paymentAvailable: 2000,
      unfundedDebt: 24000,
    });
  });

  it('nets a categorized refund while treating a reward as a debt reduction', async () => {
    await purchase();
    await purchase({ id: 'refund', amount: 4000 });
    await purchase({ id: 'reward', amount: 1000, category: 'income' });

    expect((await getPreview()).cards[0]).toMatchObject({
      balance: -25000,
      fundedSpending: 6000,
      paymentAvailable: 6000,
      unfundedDebt: 19000,
    });
  });

  it('uses split children for category funding without double-counting the account', async () => {
    await db.insertTransaction({
      id: 'split',
      account: 'card',
      amount: -10000,
      date: '2024-01-10',
      is_parent: true,
    });
    await db.insertTransaction({
      id: 'split-groceries',
      account: 'card',
      amount: -6000,
      category: 'groceries',
      date: '2024-01-10',
      is_child: true,
      parent_id: 'split',
    });
    await db.insertTransaction({
      id: 'split-fees',
      account: 'card',
      amount: -4000,
      category: 'fees',
      date: '2024-01-10',
      is_child: true,
      parent_id: 'split',
    });
    await setBudget({ category: 'fees', month: '2024-01', amount: 4000 });

    expect((await getPreview()).cards[0]).toMatchObject({
      balance: -30000,
      fundedSpending: 10000,
      paymentAvailable: 10000,
    });
  });

  it('includes carryover funds but excludes deleted, off-budget, and future activity', async () => {
    await setBudget({ category: 'groceries', month: '2023-12', amount: 5000 });
    await db.insertAccount({ id: 'offbudget', name: 'Tracking', offbudget: 1 });
    await purchase({ amount: -15000 });
    await purchase({ id: 'offbudget', amount: -10000, account: 'offbudget' });
    await purchase({ id: 'future', amount: -10000, date: '2024-02-01' });
    await purchase({ id: 'deleted', amount: -10000 });
    await db.deleteTransaction({ id: 'deleted' });

    expect((await getPreview()).cards[0]).toMatchObject({
      balance: -35000,
      paymentAvailable: 15000,
    });
  });

  it('recalculates the following month after an earlier month is edited', async () => {
    await purchase();
    expect(
      (await getPreview({ ...request, month: '2024-02' })).cards[0].balance,
    ).toBe(-30000);

    await db.updateTransaction({ id: 'purchase', amount: -4000 });

    expect(
      (await getPreview({ ...request, month: '2024-02' })).cards[0].balance,
    ).toBe(-24000);
  });

  it('blocks cash advances and broken transfer pairs instead of treating them as payments', async () => {
    await payment(-5000);
    expect(await previewCreditCardReserves(request)).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([
        { code: 'unsupported-transfer', transactionId: 'payment-card' },
      ]),
    });

    await db.updateTransaction({ id: 'payment-card', amount: 5000 });
    await db.updateTransaction({
      id: 'payment-cash',
      amount: -5000,
      date: '2024-02-01',
    });
    expect(await previewCreditCardReserves(request)).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([
        { code: 'unsupported-transfer', transactionId: 'payment-card' },
      ]),
    });
  });

  it('blocks positive balances even when the card returns to debt before month end', async () => {
    await db.insertTransaction({
      id: 'reward',
      account: 'card',
      category: 'income',
      amount: 25000,
      date: '2024-01-01',
    });
    await purchase();

    expect(await previewCreditCardReserves(request)).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([
        {
          code: 'positive-card-balance',
          accountId: 'card',
          transactionId: 'reward',
        },
      ]),
    });
  });

  it('blocks uncategorized spending and malformed splits', async () => {
    await db.insertTransaction({
      id: 'uncategorized',
      account: 'card',
      amount: -1000,
      date: '2024-01-01',
    });
    await db.insertTransaction({
      id: 'bad-split',
      account: 'cash',
      amount: -1000,
      date: '2024-01-01',
      is_parent: true,
      error: { type: 'SplitTransactionError', version: 1, difference: -1000 },
    });

    expect(await previewCreditCardReserves(request)).toMatchObject({
      status: 'blocked',
      issues: expect.arrayContaining([
        { code: 'uncategorized-spending', transactionId: 'uncategorized' },
        { code: 'invalid-split', transactionId: 'bad-split' },
      ]),
    });
  });

  it('rejects invalid months and duplicate or non-budget card selections', async () => {
    await expect(
      previewCreditCardReserves({ ...request, month: '2024-13' }),
    ).rejects.toThrow('YYYY-MM');
    await expect(
      previewCreditCardReserves({ ...request, month: '2030-01' }),
    ).rejects.toThrow('loaded envelope month');
    await expect(
      previewCreditCardReserves({ ...request, cards: [] }),
    ).rejects.toThrow('at least one');
    await expect(
      previewCreditCardReserves({
        ...request,
        cards: [request.cards[0], request.cards[0]],
      }),
    ).rejects.toThrow('distinct, existing on-budget');
    await db.updateAccount({ id: 'card', offbudget: 1 });
    await expect(previewCreditCardReserves(request)).rejects.toThrow(
      'distinct, existing on-budget',
    );
  });

  it('does not project envelope reserves for a tracking budget', async () => {
    await setType('tracking');

    await expect(previewCreditCardReserves(request)).rejects.toThrow(
      'loaded envelope month',
    );
  });
});
