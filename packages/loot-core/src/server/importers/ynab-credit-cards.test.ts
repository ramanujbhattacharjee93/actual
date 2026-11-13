import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import * as fs from '#platform/server/fs';
import * as cloudStorage from '#server/cloud-storage';
import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import * as prefs from '#server/prefs';
import { fullSync } from '#server/sync';
import {
  CREDIT_CARD_BUDGET_PREF,
  parseCreditCardBudgetConfig,
} from '#shared/credit-card-budget';

import type { Account, Budget, Category, Transaction } from './ynab5-types';

const created: string[] = [];
let documentDirectory: string;

function account(
  id: string,
  name: string,
  balance: number,
  type: Account['type'],
): Account {
  return {
    id,
    name,
    balance,
    cleared_balance: balance,
    uncleared_balance: 0,
    type,
    on_budget: true,
    closed: false,
    deleted: false,
    transfer_payee_id: null,
  };
}

function category(
  id: string,
  name: string,
  group: string,
  budgeted = 0,
  activity = 0,
  balance = 0,
): Category {
  return {
    id,
    name,
    category_group_id: group,
    budgeted,
    activity,
    balance,
    hidden: false,
    deleted: false,
  };
}

function transaction(
  id: string,
  accountId: string,
  amount: number,
  categoryId?: string,
  payeeId = 'merchant',
): Transaction {
  return {
    id,
    account_id: accountId,
    amount,
    date: '2017-01-10',
    category_id: categoryId,
    payee_id: payeeId,
    cleared: 'cleared',
    approved: true,
    deleted: false,
  };
}

function exportData(): Budget {
  const food = category('food', 'Food', 'expenses', 100000, -60000, 40000);
  const payment = category('payment', 'Card', 'cards', 50000, -20000, 30000);
  return {
    id: 'source-budget',
    name: 'Synthetic YNAB',
    accounts: [
      account('cash', 'Cash', 920000, 'checking'),
      account('card', 'Card', -180000, 'creditCard'),
    ],
    category_groups: [
      {
        id: 'income-group',
        name: 'Internal Master Category',
        deleted: false,
        hidden: false,
      },
      { id: 'expenses', name: 'Expenses', deleted: false, hidden: false },
      {
        id: 'cards',
        name: 'Credit Card Payments',
        deleted: false,
        hidden: false,
      },
    ],
    categories: [
      category('income', 'Inflow: Ready to Assign', 'income-group'),
      food,
      payment,
    ],
    payees: [
      { id: 'opening', name: 'Starting Balance', deleted: false },
      { id: 'merchant', name: 'Merchant', deleted: false },
      {
        id: 'to-card',
        name: 'Transfer : Card',
        transfer_account_id: 'card',
        deleted: false,
      },
      {
        id: 'to-cash',
        name: 'Transfer : Cash',
        transfer_account_id: 'cash',
        deleted: false,
      },
    ],
    payee_locations: [],
    transactions: [
      {
        ...transaction('cash-opening', 'cash', 1000000, 'income', 'opening'),
        date: '2017-01-01',
      },
      {
        ...transaction('card-opening', 'card', -200000, 'income', 'opening'),
        date: '2017-01-01',
      },
      transaction('purchase', 'card', -60000, 'food'),
      {
        ...transaction('cash-payment', 'cash', -80000, undefined, 'to-card'),
        transfer_account_id: 'card',
        transfer_transaction_id: 'card-payment',
        date: '2017-01-20',
      },
      {
        ...transaction('card-payment', 'card', 80000, undefined, 'to-cash'),
        transfer_account_id: 'cash',
        transfer_transaction_id: 'cash-payment',
        date: '2017-01-20',
      },
    ],
    subtransactions: [],
    scheduled_transactions: [],
    scheduled_subtransactions: [],
    months: [
      {
        month: '2017-01-01',
        income: 1000000,
        budgeted: 150000,
        activity: -60000,
        to_be_budgeted: 850000,
        deleted: false,
        categories: [food, payment],
      },
    ],
  };
}

async function importData(data: unknown, creditCards = true) {
  const result = await runHandler(handlers['import-budget'], {
    type: 'ynab5',
    creditCards,
    filename: 'synthetic-ynab.json',
    buffer: Uint8Array.from(Buffer.from(JSON.stringify(data))).buffer,
  });
  if (result.id) {
    created.push(result.id);
  }
  return result;
}

beforeAll(async () => {
  documentDirectory = await mkdtemp(join(tmpdir(), 'actual-ynab-native-'));
});

beforeEach(async () => {
  await global.emptyDatabase()();
  fs._setDocumentDir(documentDirectory);
  vi.spyOn(cloudStorage, 'upload').mockResolvedValue(undefined);
  const savePrefs = prefs.savePrefs;
  vi.spyOn(prefs, 'savePrefs').mockImplementation(async (...args) => {
    await savePrefs(...args);
    const current = prefs.getPrefs();
    // The production implementation persists metadata, but skips file writes
    // under NODE_ENV=test. Reproduce persistence in this private test directory.
    if (current?.id && (await fs.exists(fs.getBudgetDir(current.id)))) {
      await fs.writeFile(
        fs.join(fs.getBudgetDir(current.id), 'metadata.json'),
        JSON.stringify(current),
      );
    }
  });
});

afterEach(async () => {
  await runHandler(handlers['close-budget']);
  for (const id of created.splice(0)) {
    await runHandler(handlers['delete-budget'], { id });
  }
  vi.restoreAllMocks();
  fs._setDocumentDir('');
});

afterAll(async () => {
  await rm(documentDirectory, { recursive: true, force: true });
});

describe('card-aware native YNAB import', () => {
  it('preserves payment categories, allocations, balances, and stays local until reviewed', async () => {
    const result = await importData(exportData());
    expect(result.error).toBeUndefined();
    expect(result.meta).toMatchObject({
      status: 'matched',
      accountsChecked: 2,
      monthsChecked: 1,
      accountMismatches: 0,
      allocationMismatches: 0,
      activityMismatches: 0,
      availableMismatches: 0,
      blockedMonths: 0,
    });
    const stored = db.firstSync<db.DbPreference>(
      'SELECT * FROM preferences WHERE id = ?',
      [CREDIT_CARD_BUDGET_PREF],
    );
    const config = parseCreditCardBudgetConfig(stored?.value ?? '');
    expect(config.version).toBe(2);
    const state = await handlers['budget/credit-card-state']({
      month: '2017-01',
    });
    expect(state).toMatchObject({
      status: 'ready',
      toBudget: 85000,
      cards: [{ balance: -18000, paymentAvailable: 3000, payments: 8000 }],
    });
    expect(prefs.getPrefs()?.cloudFileId).toBeUndefined();
    expect(prefs.getPrefs()?.pendingYnabCardReview).toBe(true);
    await fullSync();
    expect(cloudStorage.upload).not.toHaveBeenCalled();
    expect(await db.getTransaction('purchase')).toBeTruthy();
  });

  it('uses JSON account types and preserves closed-card and hidden-category metadata', async () => {
    const data = exportData();
    data.accounts.push(
      {
        ...account('tracking', 'Tracking', 50000, 'otherAsset'),
        on_budget: false,
      },
      {
        ...account('closed-card', 'Closed card', 0, 'creditCard'),
        closed: true,
      },
    );
    data.category_groups.push({
      id: 'hidden',
      name: 'Hidden Categories',
      hidden: true,
      deleted: false,
    });
    const hidden = {
      ...category('closed-payment', 'Closed card', 'hidden'),
      original_category_group_id: 'cards',
      hidden: true,
    };
    data.categories.push(hidden);
    data.months[0].categories.push(hidden);
    data.transactions.push(
      transaction('tracking-opening', 'tracking', 50000, undefined, 'opening'),
    );
    const result = await importData(data);
    expect(result.error).toBeUndefined();
    const accounts = await handlers['accounts-get']();
    expect(
      accounts.find(row => row.name === 'Tracking')?.offbudget,
    ).toBeTruthy();
    const closed = accounts.find(row => row.name === 'Closed card');
    expect(closed?.closed).toBeTruthy();
    const stored = db.firstSync<db.DbPreference>(
      'SELECT * FROM preferences WHERE id = ?',
      [CREDIT_CARD_BUDGET_PREF],
    );
    expect(parseCreditCardBudgetConfig(stored?.value ?? '').cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: closed?.id }),
      ]),
    );
  });

  it('supports the official API nested split format without duplicate parents or children', async () => {
    const data = exportData();
    const fee = category('fee', 'Fees', 'expenses', 20000, -20000, 0);
    data.categories.push(fee);
    data.months[0].categories[0] = category(
      'food',
      'Food',
      'expenses',
      40000,
      -40000,
      0,
    );
    data.months[0].categories.push(fee);
    data.months[0].budgeted = 110000;
    data.months[0].to_be_budgeted = 890000;
    const purchase = data.transactions.find(row => row.id === 'purchase');
    if (!purchase) throw new Error('Missing synthetic purchase');
    purchase.category_id = undefined;
    purchase.subtransactions = [
      {
        id: 'food-child',
        transaction_id: purchase.id,
        amount: -40000,
        category_id: 'food',
        deleted: false,
      },
      {
        id: 'fee-child',
        transaction_id: purchase.id,
        amount: -20000,
        category_id: 'fee',
        deleted: false,
      },
    ];
    const { subtransactions: _flat, ...nested } = data;
    const result = await importData({ data: { plan: nested } });
    expect(result.error).toBeUndefined();
    const amounts = db.firstSync<{ total: number }>(
      'SELECT SUM(amount) AS total FROM v_transactions_internal_alive WHERE id IN (?, ?)',
      ['food-child', 'fee-child'],
    );
    expect(amounts?.total).toBe(-6000);
  });

  it('adds a new card to a visible payment group when the first imported card is closed and hidden', async () => {
    const data = exportData();
    data.accounts.push({
      ...account('closed', 'Closed', 0, 'creditCard'),
      closed: true,
    });
    data.category_groups.push({
      id: 'hidden',
      name: 'Hidden Categories',
      hidden: true,
      deleted: false,
    });
    const hidden = {
      ...category('closed-payment', 'Closed', 'hidden'),
      original_category_group_id: 'cards',
      hidden: true,
    };
    data.categories.unshift(hidden);
    data.months[0].categories.push(hidden);
    const result = await importData(data);
    expect(result.error).toBeUndefined();
    const accountId = await runHandler(handlers['account-create'], {
      name: 'New card',
      balance: 0,
    });
    const config = await runHandler(handlers['budget/add-credit-card'], {
      accountId,
      forkOnlyAcknowledged: true,
    });
    const mapping = config.cards.find(card => card.accountId === accountId);
    const group = db.firstSync<{ hidden: number }>(
      `SELECT g.hidden FROM category_groups g JOIN categories c ON c.cat_group = g.id
        WHERE c.id = ?`,
      [mapping?.paymentCategoryId ?? ''],
    );
    expect(group?.hidden).toBe(0);
    expect(config.cards).toHaveLength(3);
  });

  it('retains built-in interest as debt-only activity rather than spending cash twice', async () => {
    const data = exportData();
    data.categories.push(
      category('interest', 'Credit Card Interest', 'income-group'),
    );
    data.transactions.push(
      transaction('interest-charge', 'card', -2000, 'interest'),
    );
    data.accounts[1].balance -= 2000;
    data.accounts[1].cleared_balance -= 2000;
    const result = await importData(data);
    expect(result.error).toBeUndefined();
    expect(
      await handlers['budget/credit-card-state']({ month: '2017-01' }),
    ).toMatchObject({
      status: 'ready',
      cards: [{ interestCharged: 200, paymentAvailable: 3000 }],
    });
  });

  it('discards a trial that does not reconcile instead of manufacturing balancing transactions', async () => {
    const data = exportData();
    data.months[0].categories[1].balance += 10;
    const result = await importData(data);
    expect(result.error).toBe('ynab-card-reconciliation');
    expect(result.meta).toMatchObject({
      status: 'mismatch',
      availableMismatches: 1,
      firstMismatchMonth: '2017-01',
    });

    expect(prefs.getPrefs()).toBeNull();
    expect(cloudStorage.upload).not.toHaveBeenCalled();
  });

  it('rejects a Ready to Assign mismatch rather than silently releasing money', async () => {
    const data = exportData();
    data.months[0].to_be_budgeted -= 100;
    const result = await importData(data);
    expect(result.error).toBe('ynab-card-reconciliation');
    expect(result.meta).toMatchObject({
      readyToAssignMismatches: 1,
      firstMismatchMonth: '2017-01',
    });
    expect(cloudStorage.upload).not.toHaveBeenCalled();
  });

  it('rejects missing card mappings and nonrepresentable money before closing an existing budget', async () => {
    await runHandler(handlers['create-budget'], {
      budgetName: 'Existing synthetic budget',
      avoidUpload: true,
    });
    const before = prefs.getPrefs()?.id;
    if (!before) throw new Error('Missing existing fixture budget');
    created.push(before);
    const badMapping = exportData();
    badMapping.categories[2].name = 'No matching card';
    expect((await importData(badMapping)).error).toBe('ynab-card-mapping');
    expect(prefs.getPrefs()?.id).toBe(before);
    const badAmount = exportData();
    badAmount.transactions[2].amount = -60001;
    expect((await importData(badAmount)).error).toBe('ynab-card-precision');
    expect(prefs.getPrefs()?.id).toBe(before);
    expect(cloudStorage.upload).not.toHaveBeenCalled();
  });

  it('keeps the original importer behavior when card management is not selected', async () => {
    const result = await importData(exportData(), false);
    expect(result.error).toBeUndefined();
    expect(
      db.firstSync('SELECT * FROM preferences WHERE id = ?', [
        CREDIT_CARD_BUDGET_PREF,
      ]),
    ).toBeFalsy();
    expect(
      await handlers['budget/credit-card-state']({ month: '2017-01' }),
    ).toBeNull();
    const groups = await handlers['get-category-groups']();
    expect(groups.some(group => group.name === 'Credit Card Payments')).toBe(
      false,
    );
  });

  it('keeps review protection after reopening and rolls it back if an explicit upload fails', async () => {
    const result = await importData(exportData());
    if (!result.id) throw new Error('Synthetic import failed');
    await runHandler(handlers['close-budget']);
    await runHandler(handlers['load-budget'], { id: result.id });
    expect(prefs.getPrefs()?.pendingYnabCardReview).toBe(true);
    vi.mocked(cloudStorage.upload).mockRejectedValueOnce(
      new Error('synthetic upload failure'),
    );
    const failed = await runHandler(handlers['upload-budget']);
    expect(failed.error).toBeTruthy();
    expect(prefs.getPrefs()?.pendingYnabCardReview).toBe(true);
    vi.mocked(cloudStorage.upload).mockImplementation(async () => {
      expect(prefs.getPrefs()?.pendingYnabCardReview).toBe(false);
    });
    await runHandler(handlers['upload-budget']);
    expect(prefs.getPrefs()?.pendingYnabCardReview).toBe(false);
  });
});
