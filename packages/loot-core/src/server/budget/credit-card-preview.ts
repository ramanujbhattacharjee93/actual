import * as db from '#server/db';
import * as sheet from '#server/sheet';
import * as monthUtils from '#shared/months';

import { hasCreditCardBudget } from './credit-card-budget';
import {
  calculateCreditCardReserves,
  sumReserveAmounts,
} from './credit-card-reserves';
import type {
  CreditCardReserveCard,
  CreditCardReserveCategory,
  CreditCardReserveIssue,
  CreditCardReserveResult,
} from './credit-card-reserves';

type PreviewRequest = {
  month: string;
  cards: {
    accountId: string;
    openingPaymentAvailable: number;
    assigned: number;
  }[];
};

type PreviewTransaction = Pick<
  db.DbViewTransactionInternalAlive,
  | 'id'
  | 'account'
  | 'category'
  | 'amount'
  | 'date'
  | 'is_parent'
  | 'is_child'
  | 'starting_balance_flag'
  | 'transfer_id'
  | 'error'
> & {
  transfer_account: string | null;
  transfer_amount: number | null;
  transfer_date: number | null;
  transfer_back: string | null;
  transfer_offbudget: number | null;
};

function getIntegerCell(sheetName: string, name: string): number {
  const value = sheet.getCellValue(sheetName, name);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(
      'Credit-card preview requires a loaded integer budget cell.',
    );
  }
  return value;
}

/**
 * Explicitly requested, read-only snapshot of an already loaded envelope month.
 * The caller supplies opening reserves and hypothetical additional assignments.
 * Neither those assignments nor the calculated reserves are saved.
 */
export async function previewCreditCardReserves({
  month,
  cards: requestedCards,
}: PreviewRequest): Promise<CreditCardReserveResult> {
  if (!monthUtils.isValidYearMonth(month)) {
    throw new Error('Credit-card preview requires a YYYY-MM month.');
  }
  if (requestedCards.length === 0) {
    throw new Error('Choose at least one credit-card account.');
  }
  const spreadsheet = sheet.get();
  if (
    hasCreditCardBudget() ||
    !spreadsheet ||
    spreadsheet.meta().budgetType !== 'envelope' ||
    !spreadsheet.meta().createdMonths.has(month)
  ) {
    throw new Error('Credit-card preview requires a loaded envelope month.');
  }
  await sheet.waitOnSpreadsheet();

  const accounts = db.runQuery<Pick<db.DbAccount, 'id' | 'offbudget'>>(
    'SELECT id, offbudget FROM accounts WHERE tombstone = 0',
    [],
    true,
  );
  const cards = new Map<string, CreditCardReserveCard>();
  for (const requested of requestedCards) {
    if (
      !accounts.some(
        account =>
          account.id === requested.accountId && account.offbudget === 0,
      ) ||
      cards.has(requested.accountId)
    ) {
      throw new Error(
        'Choose distinct, existing on-budget credit-card accounts.',
      );
    }
    cards.set(requested.accountId, {
      ...requested,
      openingBalance: 0,
      balance: 0,
      payments: 0,
    });
  }
  // Validate caller amounts before reading any transaction history.
  calculateCreditCardReserves({ cards: [...cards.values()], categories: [] });

  const { start, end } = monthUtils.bounds(month);
  const openingBalances = db.runQuery<{ account: string; amount: number }>(
    `SELECT account, SUM(amount) AS amount
       FROM v_transactions_internal_alive
      WHERE date < ? AND is_child = 0
        AND account IN (${requestedCards.map(() => '?').join(',')})
      GROUP BY account`,
    [start, ...cards.keys()],
    true,
  );
  for (const row of openingBalances) {
    const card = cards.get(row.account);
    if (card) {
      card.openingBalance = sumReserveAmounts(row.amount);
      card.balance = card.openingBalance;
    }
  }

  const sheetName = monthUtils.sheetForMonth(month);
  const categories = new Map<
    string,
    CreditCardReserveCategory & { spendingByCard: Map<string, number> }
  >();
  const incomeCategories = new Set<string>();
  for (const category of db.runQuery<Pick<db.DbCategory, 'id' | 'is_income'>>(
    'SELECT id, is_income FROM categories WHERE tombstone = 0 ORDER BY id',
    [],
    true,
  )) {
    if (category.is_income) {
      incomeCategories.add(category.id);
      continue;
    }
    categories.set(category.id, {
      categoryId: category.id,
      availableBeforeSpending: sumReserveAmounts(
        getIntegerCell(sheetName, `leftover-${category.id}`),
        -getIntegerCell(sheetName, `sum-amount-${category.id}`),
      ),
      cashSpent: 0,
      cardSpending: [],
      spendingByCard: new Map(),
    });
  }

  const issues: CreditCardReserveIssue[] = [];
  const transactions = db.runQuery<PreviewTransaction>(
    `SELECT t.*, other.account AS transfer_account,
            other.amount AS transfer_amount, other.date AS transfer_date,
            other.transfer_id AS transfer_back, a2.offbudget AS transfer_offbudget
       FROM v_transactions_internal_alive t
       JOIN accounts a ON a.id = t.account AND a.tombstone = 0
       LEFT JOIN v_transactions_internal_alive other ON other.id = t.transfer_id
       LEFT JOIN accounts a2 ON a2.id = other.account AND a2.tombstone = 0
      WHERE t.date >= ? AND t.date <= ? AND a.offbudget = 0
      ORDER BY t.date, t.starting_balance_flag DESC, t.id`,
    [start, end],
    true,
  );

  for (const transaction of transactions) {
    if (transaction.error) {
      issues.push({ code: 'invalid-split', transactionId: transaction.id });
    }
    const card = cards.get(transaction.account);
    // Account balances count a split's parent; category activity counts children.
    if (card && !transaction.is_child) {
      card.balance = sumReserveAmounts(card.balance, transaction.amount);
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
    if (transaction.starting_balance_flag) {
      continue;
    }
    if (transaction.transfer_id) {
      const otherCard = transaction.transfer_account
        ? cards.get(transaction.transfer_account)
        : undefined;
      if (card || otherCard) {
        if (
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
          card.payments = sumReserveAmounts(card.payments, transaction.amount);
        }
        continue;
      }
      if (transaction.transfer_offbudget === 0) {
        continue;
      }
    }
    const category = transaction.category
      ? categories.get(transaction.category)
      : undefined;
    if (!category) {
      if (
        transaction.category === null ||
        !incomeCategories.has(transaction.category)
      ) {
        issues.push({
          code: 'uncategorized-spending',
          transactionId: transaction.id,
        });
      }
      continue;
    }
    if (card) {
      category.spendingByCard.set(
        card.accountId,
        sumReserveAmounts(
          category.spendingByCard.get(card.accountId) ?? 0,
          -transaction.amount,
        ),
      );
    } else {
      category.cashSpent = sumReserveAmounts(
        category.cashSpent,
        -transaction.amount,
      );
    }
  }

  const result = calculateCreditCardReserves({
    cards: [...cards.values()],
    categories: [...categories.values()].map(category => ({
      ...category,
      cardSpending: [...category.spendingByCard].map(([accountId, amount]) => ({
        accountId,
        amount,
      })),
    })),
  });
  if (issues.length > 0) {
    return {
      status: 'blocked',
      issues: [
        ...issues,
        ...(result.status === 'blocked' ? result.issues : []),
      ],
    };
  }
  return result;
}
