import path from 'node:path';

import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`YNAB JSON preserves card reserves and remains local for review (${viewport.name})`, async ({
    browser,
  }) => {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto('/');
      await new ConfigurationPage(page).importBudget(
        'nYNAB',
        path.join(__dirname, 'data/ynab-native-card-budget.json'),
        true,
      );
      const panel = page.getByTestId('credit-card-payments');
      await expect(panel).toContainText('Available to pay 30.00');
      await expect(panel).toContainText('Debt not covered 150.00');
      await expect(
        page.getByText('Credit Card Payments', { exact: true }),
      ).toBeVisible();
      const metadata = await page.evaluate(() => window.$send('load-prefs'));
      expect(metadata.cloudFileId).toBeFalsy();
      expect(metadata.pendingYnabCardReview).toBe(true);
      await page.reload();
      await expect(page.getByTestId('credit-card-payments')).toContainText(
        'Available to pay 30.00',
      );
      const status = await page.evaluate(() =>
        window.$send('budget/credit-card-state', { month: '2017-01' }),
      );
      expect(status).toMatchObject({ status: 'ready', toBudget: 85000 });
    } finally {
      await page.close();
    }
  });
}
