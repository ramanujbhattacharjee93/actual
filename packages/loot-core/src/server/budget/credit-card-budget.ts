import * as db from '#server/db';
import * as sheet from '#server/sheet';
import { batchMessages } from '#server/sync';
import {
  CREDIT_CARD_BUDGET_PREF,
  parseCreditCardBudgetConfig,
} from '#shared/credit-card-budget';
import type {
  CreditCardBudgetConfig,
  CreditCardBudgetState,
} from '#shared/credit-card-budget';
import * as monthUtils from '#shared/months';

import { calculateCreditCardMonth } from './credit-card-month';
import type {
  CreditCardMonthCategory,
  CreditCardMonthTransaction,
} from './credit-card-month';
import { calculateCreditCardMonth as calculateLegacyCreditCardMonth } from './credit-card-month-v1';
import { sumReserveAmounts as sum } from './credit-card-reserves';

const STATE_CELL = 'credit-card-state';
const REVISION_CELL = '__global!credit-card-budget-revision';
export const BLOCKED_BUDGET_VALUE = '#CREDIT-CARD-BLOCKED';

export function hasCreditCardBudget(): boolean {
  return Boolean(
    db.firstSync<db.DbPreference>('SELECT * FROM preferences WHERE id = ?', [
      CREDIT_CARD_BUDGET_PREF,
    ]),
  );
}

function getConfig(): CreditCardBudgetConfig {
  const preference = db.firstSync<db.DbPreference>(
    'SELECT * FROM preferences WHERE id = ?',
    [CREDIT_CARD_BUDGET_PREF],
  );
  return parseCreditCardBudgetConfig(preference?.value ?? '');
}

function readState(
  value: string | number | boolean,
): CreditCardBudgetState | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // This cell is serialized exclusively by calculateMonth below; it is not
  // a caller-supplied configuration or transaction payload.
  const state: CreditCardBudgetState = JSON.parse(value);
  return state;
}

function calculateMonth(
  month: string,
  previousValue: string | number | boolean,
): CreditCardBudgetState {
  let config: CreditCardBudgetConfig;
  try {
    config = getConfig();
  } catch {
    return {
      status: 'blocked',
      month,
      issues: [{ code: 'invalid-configuration' }],
    };
  }
  const categories = db.runQuery<db.DbCategory>(
    `SELECT c.* FROM categories c
       JOIN category_groups g ON g.id = c.cat_group AND g.tombstone = 0
      WHERE c.tombstone = 0 ORDER BY c.id`,
    [],
    true,
  );
  const accounts = db.runQuery<db.DbAccount>(
    'SELECT * FROM accounts WHERE tombstone = 0 AND offbudget = 0',
    [],
    true,
  );
  const budgetType = db.firstSync<db.DbPreference>(
    'SELECT * FROM preferences WHERE id = ?',
    ['budgetType'],
  );
  if (budgetType && budgetType.value !== 'envelope') {
    return {
      status: 'blocked',
      month,
      issues: [{ code: 'invalid-configuration' }],
    };
  }
  for (const card of config.cards) {
    if (
      !accounts.some(account => account.id === card.accountId) ||
      !categories.some(
        category =>
          category.id === card.paymentCategoryId && !category.is_income,
      )
    ) {
      return {
        status: 'blocked',
        month,
        issues: [
          {
            code: 'invalid-mapping',
            accountId: card.accountId,
            categoryId: card.paymentCategoryId,
          },
        ],
      };
    }
  }
  if (
    (config.debtCategoryIds ?? []).some(
      id =>
        !categories.some(category => category.id === id && !category.is_income),
    )
  ) {
    return { status: 'blocked', month, issues: [{ code: 'invalid-mapping' }] };
  }
  const dbMonth = Number(month.replace('-', ''));
  const budgets = db.runQuery<db.DbZeroBudget>(
    'SELECT * FROM zero_budgets WHERE month = ?',
    [dbMonth],
    true,
  );
  const inputs: CreditCardMonthCategory[] = categories.map(category => {
    const budget = budgets.find(row => row.category === category.id);
    return {
      id: category.id,
      isIncome: category.is_income === 1,
      assigned: budget?.amount ?? 0,
      carryover: budget?.carryover === 1,
    };
  });
  const { start, end } = monthUtils.bounds(month);
  const transactions = db.runQuery<CreditCardMonthTransaction>(
    `SELECT t.*, other.account AS transfer_account,
            other.amount AS transfer_amount, other.date AS transfer_date,
            other.transfer_id AS transfer_back, a2.offbudget AS transfer_offbudget,
            other.is_parent AS transfer_is_parent
       FROM v_transactions_internal_alive t
       JOIN accounts a ON a.id = t.account AND a.tombstone = 0
       LEFT JOIN v_transactions_internal_alive other ON other.id = t.transfer_id
       LEFT JOIN accounts a2 ON a2.id = other.account AND a2.tombstone = 0
      WHERE t.date >= ? AND t.date <= ? AND a.offbudget = 0
      ORDER BY t.date, t.starting_balance_flag DESC, t.id`,
    [start, end],
    true,
  );
  const budgetMonth = db.firstSync<db.DbZeroBudgetMonth>(
    'SELECT * FROM zero_budget_months WHERE id = ?',
    [month],
  );
  try {
    const calculate =
      config.version === 1
        ? calculateLegacyCreditCardMonth
        : calculateCreditCardMonth;
    return calculate({
      month,
      config,
      categories: inputs,
      transactions,
      buffered: budgetMonth?.buffered ?? 0,
      previous: readState(previousValue),
    });
  } catch {
    return {
      status: 'blocked',
      month,
      issues: [{ code: 'invalid-amount' }],
    };
  }
}

export async function getCreditCardBudgetState({
  month,
}: {
  month: string;
}): Promise<CreditCardBudgetState | null> {
  if (!hasCreditCardBudget()) {
    return null;
  }
  if (
    !monthUtils.isValidYearMonth(month) ||
    !sheet.get().meta().createdMonths.has(month)
  ) {
    throw new Error('Credit-card budgeting requires a loaded YYYY-MM month.');
  }
  await sheet.waitOnSpreadsheet();
  return (
    readState(
      sheet.getCellValue(monthUtils.sheetForMonth(month), STATE_CELL),
    ) ?? {
      status: 'blocked',
      month,
      issues: [{ code: 'invalid-configuration' }],
    }
  );
}

export async function getCreditCardBudgetAssignments({
  month,
}: {
  month: string;
}): Promise<{ categoryId: string; assigned: number }[]> {
  if (!hasCreditCardBudget() || !monthUtils.isValidYearMonth(month)) {
    throw new Error(
      'Credit-card assignments require an enabled YYYY-MM month.',
    );
  }
  return db.runQuery<{ categoryId: string; assigned: number }>(
    `SELECT c.id AS categoryId, COALESCE(b.amount, 0) AS assigned
       FROM categories c
       LEFT JOIN zero_budgets b ON b.category = c.id AND b.month = ?
      WHERE c.tombstone = 0 AND c.is_income = 0`,
    [Number(month.replace('-', ''))],
    true,
  );
}

function createCalculatedCell(
  sheetName: string,
  name: string,
  calculate: (
    state: Extract<CreditCardBudgetState, { status: 'ready' }>,
  ) => number,
) {
  sheet.get().createDynamic(sheetName, name, {
    initialValue: 0,
    dependencies: [STATE_CELL],
    run: (value: string) => {
      const state = readState(value);
      return state?.status === 'ready'
        ? calculate(state)
        : BLOCKED_BUDGET_VALUE;
    },
  });
}

export function createCreditCardBudgets(requestedMonths: string[]): void {
  if (requestedMonths.length === 0) {
    return;
  }
  const spreadsheet = sheet.get();
  const meta = spreadsheet.meta();
  const months = [
    ...new Set([...meta.createdMonths, ...requestedMonths]),
  ].sort();
  const earliest = db.firstSync<{ month: number | null }>(
    `SELECT MIN(month) AS month FROM (
       SELECT date / 100 AS month FROM v_transactions_internal_alive
       UNION ALL
       SELECT month FROM zero_budgets WHERE amount != 0 OR carryover = 1
     )`,
  )?.month;
  if (earliest) {
    const earliestMonth = monthUtils.monthFromDate(
      db.fromDateRepr(earliest * 100 + 1),
    );
    if (earliestMonth < months[0]) {
      months.unshift(earliestMonth);
    }
  }
  const range = monthUtils.rangeInclusive(months[0], months[months.length - 1]);
  const categories = db.runQuery<db.DbCategory>(
    'SELECT * FROM categories WHERE tombstone = 0',
    [],
    true,
  );
  const groups = db.runQuery<db.DbCategoryGroup>(
    'SELECT * FROM category_groups WHERE tombstone = 0',
    [],
    true,
  );
  spreadsheet.startTransaction();
  try {
    spreadsheet.createStatic('__global', 'credit-card-budget-revision', 0);
    const blankSheet = monthUtils.sheetForMonth(monthUtils.prevMonth(range[0]));
    spreadsheet.createStatic(blankSheet, STATE_CELL, false);
    for (const month of range) {
      const sheetName = monthUtils.sheetForMonth(month);
      const prevSheetName = monthUtils.sheetForMonth(
        monthUtils.prevMonth(month),
      );
      spreadsheet.createDynamic(sheetName, STATE_CELL, {
        initialValue: false,
        refresh: true,
        dependencies: [REVISION_CELL, `${prevSheetName}!${STATE_CELL}`],
        run: (_revision: number, previousValue: string | number | boolean) =>
          JSON.stringify(calculateMonth(month, previousValue)),
      });
      for (const category of categories) {
        spreadsheet.createStatic(sheetName, `budget-${category.id}`, 0);
        spreadsheet.createStatic(sheetName, `carryover-${category.id}`, false);
        createCalculatedCell(
          sheetName,
          `sum-amount-${category.id}`,
          state => state.categories[category.id]?.activity ?? 0,
        );
        if (!category.is_income) {
          createCalculatedCell(
            sheetName,
            `leftover-${category.id}`,
            state => state.categories[category.id]?.available ?? 0,
          );
          createCalculatedCell(
            sheetName,
            `credit-overspent-${category.id}`,
            state => state.categories[category.id]?.creditOverspent ?? 0,
          );
          createCalculatedCell(
            sheetName,
            `cash-overspent-${category.id}`,
            state => state.categories[category.id]?.cashOverspent ?? 0,
          );
          createCalculatedCell(
            sheetName,
            `payment-debt-${category.id}`,
            state =>
              Math.max(
                0,
                -(
                  state.cards.find(
                    card => card.paymentCategoryId === category.id,
                  )?.balance ?? 0
                ),
              ),
          );
          createCalculatedCell(
            sheetName,
            `leftover-pos-${category.id}`,
            state => Math.max(0, state.categories[category.id]?.available ?? 0),
          );
        }
      }
      for (const group of groups) {
        for (const [prefix, field] of [
          ['group-sum-amount', 'activity'],
          ['group-budget', 'assigned'],
          ['group-leftover', 'available'],
        ] as const) {
          createCalculatedCell(sheetName, `${prefix}-${group.id}`, state =>
            sum(
              ...db
                .runQuery<Pick<db.DbCategory, 'id'>>(
                  'SELECT id FROM categories WHERE cat_group = ? AND tombstone = 0',
                  [group.id],
                  true,
                )
                .map(category => state.categories[category.id]?.[field] ?? 0),
            ),
          );
        }
      }
      for (const [cell, field] of [
        ['total-income', 'income'],
        ['from-last-month', 'fromLastMonth'],
        ['last-month-overspent', 'lastMonthOverspent'],
        ['available-funds', 'availableFunds'],
        ['total-budgeted', 'totalBudgeted'],
        ['total-spent', 'totalSpent'],
        ['total-leftover', 'totalAvailable'],
        ['buffered-selected', 'buffered'],
        ['to-budget', 'toBudget'],
      ] as const) {
        createCalculatedCell(sheetName, cell, state => state[field]);
      }
      spreadsheet.createStatic(sheetName, 'buffered', 0);
      createCalculatedCell(
        sheetName,
        'buffered-auto',
        state => state.autoBuffered ?? 0,
      );
      createCalculatedCell(
        sheetName,
        'from-credit',
        state => state.creditAdjustments ?? 0,
      );
      meta.createdMonths.add(month);
    }
    spreadsheet.setMeta(meta);
  } finally {
    spreadsheet.endTransaction();
  }
}

export function invalidateCreditCardBudgets(): void {
  createCreditCardBudgets([...sheet.get().meta().createdMonths]);
  const revision = sheet.getCellValue(
    '__global',
    'credit-card-budget-revision',
  );
  sheet
    .get()
    .set(REVISION_CELL, typeof revision === 'number' ? revision + 1 : 1);
}

export async function enableCreditCardBudget({
  accountIds,
  paymentGroupName,
  forkOnlyAcknowledged,
}: {
  accountIds: string[];
  paymentGroupName: string;
  forkOnlyAcknowledged: boolean;
}): Promise<CreditCardBudgetConfig> {
  if (hasCreditCardBudget()) {
    throw new Error('Credit-card mappings cannot be changed after enablement.');
  }
  if (!forkOnlyAcknowledged) {
    throw new Error('Acknowledge the fork-only accounting requirement.');
  }
  const budgetType = db.firstSync<db.DbPreference>(
    'SELECT * FROM preferences WHERE id = ?',
    ['budgetType'],
  );
  if (budgetType && budgetType.value !== 'envelope') {
    throw new Error('Credit-card budgeting requires an envelope budget.');
  }
  const existing = db.firstSync<{ count: number }>(
    `SELECT (
       (SELECT COUNT(*) FROM transactions WHERE tombstone = 0 AND
         (starting_balance_flag IS NULL OR starting_balance_flag = 0)) +
       (SELECT COUNT(*) FROM zero_budgets WHERE amount != 0 OR carryover = 1) +
       (SELECT COUNT(*) FROM reflect_budgets WHERE amount != 0) +
       (SELECT COUNT(*) FROM zero_budget_months WHERE buffered != 0)
     ) AS count`,
  );
  if (existing?.count) {
    throw new Error('Use a new budget or the card-aware YNAB importer.');
  }
  if (
    !paymentGroupName.trim() ||
    db.firstSync<db.DbCategoryGroup>(
      'SELECT * FROM category_groups WHERE name = ? AND tombstone = 0',
      [paymentGroupName.trim()],
    )
  ) {
    throw new Error('Choose a new, nonempty payment category group name.');
  }
  const accounts = db.runQuery<db.DbAccount>(
    'SELECT * FROM accounts WHERE tombstone = 0 AND offbudget = 0 AND closed = 0',
    [],
    true,
  );
  if (
    accountIds.length === 0 ||
    new Set(accountIds).size !== accountIds.length ||
    accountIds.some(id => !accounts.some(account => account.id === id))
  ) {
    throw new Error('Choose distinct, open on-budget credit-card accounts.');
  }
  const config: CreditCardBudgetConfig = { version: 2, cards: [] };
  await batchMessages(async () => {
    const groupId = await db.insertCategoryGroup({
      name: paymentGroupName.trim(),
    });
    for (const accountId of accountIds) {
      const account = accounts.find(row => row.id === accountId);
      if (!account) {
        throw new Error('Credit-card account no longer exists.');
      }
      const paymentCategoryId = await db.insertCategory({
        name: account.name,
        cat_group: groupId,
      });
      config.cards.push({ accountId, paymentCategoryId });
    }
    await db.update('preferences', {
      id: CREDIT_CARD_BUDGET_PREF,
      value: JSON.stringify(config),
    });
  });
  return config;
}

export async function addCreditCard({
  accountId,
  forkOnlyAcknowledged,
  paymentGroupName = 'Credit Card Payments',
}: {
  accountId: string;
  forkOnlyAcknowledged: boolean;
  paymentGroupName?: string;
}): Promise<CreditCardBudgetConfig> {
  const config = getConfig();
  if (config.version !== 2 || !forkOnlyAcknowledged) {
    throw new Error('Adding cards requires native fork accounting.');
  }
  if (!paymentGroupName.trim()) {
    throw new Error('Choose a nonempty payment category group name.');
  }
  if (config.cards.some(card => card.accountId === accountId)) {
    throw new Error('This account already has a payment category.');
  }
  const account = db.firstSync<db.DbAccount>(
    'SELECT * FROM accounts WHERE id = ? AND tombstone = 0 AND offbudget = 0 AND closed = 0',
    [accountId],
  );
  const spending = db.firstSync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM v_transactions_internal_alive
      WHERE account = ? AND COALESCE(starting_balance_flag, 0) = 0`,
    [accountId],
  );
  if (!account || spending?.count) {
    throw new Error(
      'Choose a new on-budget card account with only a starting balance.',
    );
  }
  const category = db.firstSync<db.DbCategory>(
    `SELECT c.* FROM categories c JOIN category_groups g ON g.id = c.cat_group
      WHERE c.id IN (${config.cards.map(() => '?').join(',')})
        AND c.tombstone = 0 AND c.hidden = 0 AND g.tombstone = 0 AND g.hidden = 0
      ORDER BY c.id LIMIT 1`,
    config.cards.map(card => card.paymentCategoryId),
  );
  await batchMessages(async () => {
    let groupId = category?.cat_group;
    if (!groupId) {
      const groups = db.runQuery<db.DbCategoryGroup>(
        'SELECT * FROM category_groups WHERE tombstone = 0',
        [],
        true,
      );
      groupId = groups.find(
        group =>
          group.name === paymentGroupName && !group.hidden && !group.is_income,
      )?.id;
      if (!groupId) {
        let name = paymentGroupName;
        let suffix = 1;
        while (groups.some(group => group.name === name)) {
          name = `${paymentGroupName} (${suffix++})`;
        }
        groupId = await db.insertCategoryGroup({ name });
      }
    }
    const paymentCategoryId = await db.insertCategory({
      name: account.name,
      cat_group: groupId,
    });
    config.cards.push({ accountId, paymentCategoryId });
    await db.update('preferences', {
      id: CREDIT_CARD_BUDGET_PREF,
      value: JSON.stringify(config),
    });
  });
  return config;
}
