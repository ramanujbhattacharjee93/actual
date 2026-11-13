// @ts-strict-ignore
import { logger } from '#platform/server/log';
import { handlers } from '#server/main';

import { importActual } from './actual';
import {
  normalizeYnabCardImport,
  reconcileYnabCreditCards,
  YnabCreditCardImportError,
} from './ynab-credit-cards';
import * as YNAB4 from './ynab4';
import * as YNAB5 from './ynab5';

export type ImportableBudgetType = 'ynab4' | 'ynab5' | 'actual';

type Importer = {
  parseFile(buffer: Buffer): unknown;
  getBudgetName(filepath: string, data: unknown): string | null;
  doImport(data: unknown): Promise<unknown>;
};

const importers: Record<Exclude<ImportableBudgetType, 'actual'>, Importer> = {
  ynab4: YNAB4,
  ynab5: YNAB5,
};

export async function handleBudgetImport(
  type: ImportableBudgetType,
  filepath: string,
  buffer: Buffer,
  { creditCards = false }: { creditCards?: boolean } = {},
) {
  if (type === 'ynab5' && creditCards) {
    return importYnabCreditCards(filepath, buffer);
  }
  if (type === 'actual') {
    return importActual(filepath, buffer);
  }
  const importer = importers[type];
  try {
    let data;
    let budgetName: string;
    try {
      data = importer.parseFile(buffer);
      budgetName = importer.getBudgetName(filepath, data);
    } catch (e) {
      logger.error('failed to parse file', e);
    }
    if (!budgetName) {
      return { error: 'not-' + type };
    }

    try {
      await handlers['api/start-import']({ budgetName });
    } catch (e) {
      logger.error('failed to start import', e);
      return { error: 'unknown' };
    }
    await importer.doImport(data);
  } catch (e) {
    await handlers['api/abort-import']();
    logger.error('failed to run import', e);
    return { error: 'unknown' };
  }

  await handlers['api/finish-import']();
}

async function importYnabCreditCards(filepath: string, buffer: Buffer) {
  let started = false;
  try {
    const data = normalizeYnabCardImport(YNAB5.parseFile(buffer));
    const budgetName = YNAB5.getBudgetName(filepath, data);
    if (typeof budgetName !== 'string' || !budgetName.trim()) {
      throw new YnabCreditCardImportError('ynab-card-source');
    }
    await handlers['api/start-import']({ budgetName });
    started = true;
    const ids = await YNAB5.doImport(data, { creditCards: true });
    const report = await reconcileYnabCreditCards(data, ids);
    if (report.status !== 'matched') {
      throw new YnabCreditCardImportError('ynab-card-reconciliation', report);
    }
    // Review locally before uploading. A failed import cannot publish a
    // partially migrated budget or overwrite an existing synced budget.
    await handlers['api/finish-import']({ avoidUpload: true });
    return { meta: report };
  } catch (error) {
    if (started) {
      await handlers['api/abort-import']();
    }
    logger.error(
      'Card-aware YNAB import failed',
      error instanceof Error ? error.name : 'unknown',
    );
    return error instanceof YnabCreditCardImportError
      ? { error: error.code, meta: error.report }
      : { error: 'ynab-card-source' };
  }
}
