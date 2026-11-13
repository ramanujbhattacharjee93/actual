import * as budget from '#server/budget/base';
import { getCreditCardBudgetState } from '#server/budget/credit-card-budget';
import * as db from '#server/db';
import * as sheet from '#server/sheet';
import { CREDIT_CARD_BUDGET_PREF } from '#shared/credit-card-budget';
import type { CreditCardBudgetConfig } from '#shared/credit-card-budget';
import * as monthUtils from '#shared/months';

import type { Budget, Category } from './ynab5-types';

export class YnabCreditCardImportError extends Error {
  constructor(
    public code:
      | 'ynab-card-source'
      | 'ynab-card-mapping'
      | 'ynab-card-precision'
      | 'ynab-card-reconciliation',
    public report?: YnabReconciliation,
  ) {
    super(code);
    this.name = 'YnabCreditCardImportError';
  }
}

export type YnabReconciliation = {
  status: 'matched' | 'mismatch';
  accountsChecked: number;
  monthsChecked: number;
  accountMismatches: number;
  allocationMismatches: number;
  activityMismatches: number;
  availableMismatches: number;
  readyToAssignMismatches: number;
  blockedMonths: number;
  firstMismatchMonth?: string;
};

export function ynabMinorUnits(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount % 10 !== 0) {
    throw new YnabCreditCardImportError('ynab-card-precision');
  }
  return amount / 10;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isInterest(data: Budget, category: Category): boolean {
  const group = data.category_groups.find(
    group => group.id === category.category_group_id,
  );
  return Boolean(
    group &&
    sameName(group.name, 'Internal Master Category') &&
    sameName(category.name, 'Credit Card Interest'),
  );
}

export function normalizeYnabCardImport(data: Budget): Budget {
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray(data.accounts) ||
    !Array.isArray(data.categories) ||
    !Array.isArray(data.category_groups) ||
    !Array.isArray(data.payees) ||
    !Array.isArray(data.transactions) ||
    !Array.isArray(data.months)
  ) {
    throw new YnabCreditCardImportError('ynab-card-source');
  }
  const normalized: Budget = {
    ...data,
    subtransactions:
      data.subtransactions ??
      data.transactions.flatMap(transaction =>
        (transaction.subtransactions ?? []).map(child => ({
          ...child,
          transaction_id: transaction.id,
        })),
      ),
    scheduled_transactions: data.scheduled_transactions ?? [],
    scheduled_subtransactions:
      data.scheduled_subtransactions ??
      (data.scheduled_transactions ?? []).flatMap(transaction =>
        (transaction.subtransactions ?? []).map(child => ({
          ...child,
          scheduled_transaction_id: transaction.id,
        })),
      ),
    payee_locations: data.payee_locations ?? [],
  };
  for (const entities of [
    normalized.accounts,
    normalized.categories,
    normalized.category_groups,
    normalized.payees,
    normalized.transactions,
    normalized.subtransactions,
    normalized.scheduled_transactions,
    normalized.scheduled_subtransactions,
  ]) {
    if (
      !Array.isArray(entities) ||
      entities.some(
        entity => !entity || typeof entity.id !== 'string' || !entity.id,
      ) ||
      new Set(entities.map(entity => entity.id)).size !== entities.length
    ) {
      throw new YnabCreditCardImportError('ynab-card-source');
    }
  }
  if (
    new Set(
      [...normalized.transactions, ...normalized.subtransactions].map(
        row => row.id,
      ),
    ).size !==
    normalized.transactions.length + normalized.subtransactions.length
  ) {
    throw new YnabCreditCardImportError('ynab-card-source');
  }
  for (const account of normalized.accounts.filter(row => !row.deleted)) {
    if (
      typeof account.on_budget !== 'boolean' ||
      typeof account.closed !== 'boolean' ||
      typeof account.type !== 'string' ||
      typeof account.name !== 'string' ||
      !account.name.trim()
    ) {
      throw new YnabCreditCardImportError('ynab-card-source');
    }
    ynabMinorUnits(account.balance);
    ynabMinorUnits(account.cleared_balance);
    ynabMinorUnits(account.uncleared_balance);
  }
  for (const transaction of [
    ...normalized.transactions,
    ...normalized.subtransactions,
    ...normalized.scheduled_transactions,
    ...normalized.scheduled_subtransactions,
  ]) {
    if (!transaction.deleted) {
      ynabMinorUnits(transaction.amount);
    }
  }
  if (
    normalized.transactions.some(
      transaction =>
        !transaction.deleted &&
        !monthUtils.isValidYearMonthDay(transaction.date),
    )
  ) {
    throw new YnabCreditCardImportError('ynab-card-source');
  }
  for (const month of normalized.months) {
    if (
      !month ||
      !monthUtils.isValidYearMonthDay(month.month) ||
      !month.month.endsWith('-01') ||
      !Array.isArray(month.categories)
    ) {
      throw new YnabCreditCardImportError('ynab-card-source');
    }
    ynabMinorUnits(month.to_be_budgeted);
    for (const category of month.categories) {
      ynabMinorUnits(category.budgeted);
      ynabMinorUnits(category.activity);
      ynabMinorUnits(category.balance);
    }
  }
  getYnabCreditCardMappings(normalized);
  return normalized;
}

export function getYnabCreditCardMappings(data: Budget): {
  accountId: string;
  categoryId: string;
}[] {
  const cards = data.accounts.filter(
    account =>
      !account.deleted &&
      account.on_budget &&
      (account.type === 'creditCard' || account.type === 'lineOfCredit'),
  );
  const paymentGroups = new Set(
    data.category_groups
      .filter(group => sameName(group.name, 'Credit Card Payments'))
      .map(group => group.id),
  );
  const categories = data.categories.filter(
    category =>
      !category.deleted &&
      (paymentGroups.has(category.category_group_id) ||
        Boolean(
          category.original_category_group_id &&
          paymentGroups.has(category.original_category_group_id),
        )),
  );
  const used = new Set<string>();
  const mappings = categories.map(category => {
    const matches = cards.filter(account =>
      sameName(account.name, category.name),
    );
    if (matches.length !== 1 || used.has(matches[0].id)) {
      throw new YnabCreditCardImportError('ynab-card-mapping');
    }
    used.add(matches[0].id);
    return { accountId: matches[0].id, categoryId: category.id };
  });
  if (used.size !== cards.length) {
    throw new YnabCreditCardImportError('ynab-card-mapping');
  }
  return mappings;
}

export async function installImportedCreditCards(
  data: Budget,
  entityIdMap: Map<string, string>,
): Promise<void> {
  const config: CreditCardBudgetConfig = { version: 2, cards: [] };
  for (const mapping of getYnabCreditCardMappings(data)) {
    const accountId = entityIdMap.get(mapping.accountId);
    const paymentCategoryId = entityIdMap.get(mapping.categoryId);
    if (!accountId || !paymentCategoryId) {
      throw new YnabCreditCardImportError('ynab-card-mapping');
    }
    config.cards.push({ accountId, paymentCategoryId });
  }
  if (config.cards.length === 0) {
    return;
  }
  const interest = data.categories.filter(
    category => !category.deleted && isInterest(data, category),
  );
  if (interest.length > 0) {
    const groupNames = new Set(
      db
        .runQuery<Pick<db.DbCategoryGroup, 'name'>>(
          'SELECT name FROM category_groups WHERE tombstone = 0',
          [],
          true,
        )
        .map(group => group.name),
    );
    let name = 'Credit Card Interest (system)';
    let suffix = 1;
    while (groupNames.has(name)) {
      name = `Credit Card Interest (system ${suffix++})`;
    }
    const groupId = await db.insertCategoryGroup({ name, hidden: 1 });
    config.debtCategoryIds = [];
    for (const source of interest) {
      const id = await db.insertCategory({
        name: source.name,
        cat_group: groupId,
        hidden: 1,
      });
      entityIdMap.set(source.id, id);
      config.debtCategoryIds.push(id);
    }
  }
  await db.update('preferences', {
    id: CREDIT_CARD_BUDGET_PREF,
    value: JSON.stringify(config),
  });
}

/**
 * Compare imported account balances and historical envelopes to the source
 * before upload. Only counts and the first failing month leave this function.
 */
export async function reconcileYnabCreditCards(
  data: Budget,
  entityIdMap: Map<string, string>,
): Promise<YnabReconciliation> {
  // Import mode bypasses spreadsheet projections. Cached cells still belong
  // to the blank budget and must not replace newly imported allocations.
  sheet.get().markCacheDirty();
  await sheet.reloadSpreadsheet(db);
  await budget.createAllBudgets();
  await sheet.waitOnSpreadsheet();
  const report: YnabReconciliation = {
    status: 'matched',
    accountsChecked: 0,
    monthsChecked: 0,
    accountMismatches: 0,
    allocationMismatches: 0,
    activityMismatches: 0,
    availableMismatches: 0,
    blockedMonths: 0,
    readyToAssignMismatches: 0,
  };
  for (const account of data.accounts.filter(account => !account.deleted)) {
    const id = entityIdMap.get(account.id);
    report.accountsChecked++;
    if (!id) {
      report.accountMismatches++;
      continue;
    }
    const amounts = db.firstSync<{ balance: number; cleared: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS balance,
              COALESCE(SUM(CASE WHEN cleared = 1 THEN amount ELSE 0 END), 0) AS cleared
         FROM v_transactions_internal_alive WHERE account = ? AND is_child = 0`,
      [id],
    );
    if (
      amounts?.balance !== ynabMinorUnits(account.balance) ||
      amounts.cleared !== ynabMinorUnits(account.cleared_balance) ||
      amounts.balance - amounts.cleared !==
        ynabMinorUnits(account.uncleared_balance)
    ) {
      report.accountMismatches++;
    }
  }
  for (const sourceMonth of [...data.months].sort((a, b) =>
    a.month < b.month ? -1 : 1,
  )) {
    const month = sourceMonth.month.slice(0, 7);
    await budget.createBudget([month]);
    const state = await getCreditCardBudgetState({ month });
    report.monthsChecked++;
    if (state?.status === 'blocked') {
      report.blockedMonths++;
      report.firstMismatchMonth ??= month;
      continue;
    }
    const before =
      report.allocationMismatches +
      report.activityMismatches +
      report.availableMismatches;
    const sheetName = monthUtils.sheetForMonth(month);
    if (
      sheet.getCellValue(sheetName, 'to-budget') !==
      ynabMinorUnits(sourceMonth.to_be_budgeted)
    ) {
      report.readyToAssignMismatches++;
      report.firstMismatchMonth ??= month;
    }
    for (const source of sourceMonth.categories.filter(
      category => !category.deleted,
    )) {
      const id = entityIdMap.get(source.id);
      const category = id
        ? db.firstSync<db.DbCategory>(
            'SELECT * FROM categories WHERE id = ? AND tombstone = 0',
            [id],
          )
        : undefined;
      if (!category) {
        const original = data.categories.find(
          category => category.id === source.id,
        );
        const group = data.category_groups.find(
          group => group.id === original?.category_group_id,
        );
        if (
          group &&
          sameName(group.name, 'Internal Master Category') &&
          source.budgeted === 0 &&
          source.activity === 0 &&
          source.balance === 0
        ) {
          continue;
        }
        report.availableMismatches++;
        continue;
      }
      if (category.is_income || isInterest(data, source)) {
        continue;
      }
      if (
        sheet.getCellValue(sheetName, `budget-${id}`) !==
        ynabMinorUnits(source.budgeted)
      ) {
        report.allocationMismatches++;
      }
      if (
        sheet.getCellValue(sheetName, `sum-amount-${id}`) !==
        ynabMinorUnits(source.activity)
      ) {
        report.activityMismatches++;
      }
      if (
        sheet.getCellValue(sheetName, `leftover-${id}`) !==
        ynabMinorUnits(source.balance)
      ) {
        report.availableMismatches++;
      }
    }
    if (
      before !==
      report.allocationMismatches +
        report.activityMismatches +
        report.availableMismatches
    ) {
      report.firstMismatchMonth ??= month;
    }
  }
  if (
    report.accountMismatches ||
    report.allocationMismatches ||
    report.activityMismatches ||
    report.availableMismatches ||
    report.readyToAssignMismatches ||
    report.blockedMonths
  ) {
    report.status = 'mismatch';
  }
  return report;
}
