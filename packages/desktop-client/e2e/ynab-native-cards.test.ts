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
      await expect(page.getByTestId('credit-card-payments')).toHaveCount(0);
      await expect(
        page.getByText('Credit Card Payments', { exact: true }),
      ).toBeVisible();
      const balance =
        viewport.name === 'mobile'
          ? page.getByRole('button', {
              name: 'Open balance menu for Card category',
              exact: true,
            })
          : page
              .getByRole('button', {
                name: /Card payment is underfunded.*30\.00/,
              })
              .first();
      await balance.click();
      const details = page.getByTestId('credit-card-details');
      await expect(details).toContainText('Available to pay30.00');
      await expect(details).toContainText('Debt not covered150.00');
      await expect(
        page.getByText('Rollover overspending', { exact: true }),
      ).toHaveCount(0);
      for (const theme of ['auto', 'dark', 'midnight'] as const) {
        await page.evaluate(theme => window.Actual.setTheme(theme), theme);
        await expect(details).toBeVisible();
        const bounds = await details.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({
          path: test
            .info()
            .outputPath(`card-details-${viewport.name}-${theme}.png`),
        });
      }
      await page.keyboard.press('Escape');
      await expect(details).toHaveCount(0);
      const metadata = await page.evaluate(() => window.$send('load-prefs'));
      expect(metadata.cloudFileId).toBeFalsy();
      expect(metadata.pendingYnabCardReview).toBe(true);
      await page.reload();
      await expect(balance).toBeVisible();
      await expect(page.getByTestId('credit-card-payments')).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath(`budget-${viewport.name}.png`),
      });
      const status = await page.evaluate(() =>
        window.$send('budget/credit-card-state', { month: '2017-01' }),
      );
      expect(status).toMatchObject({ status: 'ready', toBudget: 85000 });
    } finally {
      await page.close();
    }
  });
}
