import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`credit-card accounting persists and guards invalid data (${viewport.name})`, async ({
    browser,
  }) => {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto('/');
      const configuration = new ConfigurationPage(page);
      await configuration.startFresh();
      await page.evaluate(async () => {
        await window.$send('account-create', {
          name: 'Test cash',
          balance: 1000,
          offBudget: false,
        });
        await window.$send('account-create', {
          name: 'Test card',
          balance: -200,
          offBudget: false,
        });
        await window.$send('account-create', {
          name: 'Test other card',
          balance: 0,
          offBudget: false,
        });
      });
      await page.reload();
      // Settings are responsive, but this route is shared by desktop and mobile.
      await page.goto('/settings/general');
      const enable = page.getByRole('button', {
        name: 'Enable credit-card payment categories',
      });
      await expect(enable).toBeDisabled();
      await page
        .getByRole('checkbox', { name: 'Test card', exact: true })
        .check();
      await page
        .getByRole('checkbox', { name: 'Test other card', exact: true })
        .check();
      await page
        .getByRole('checkbox', {
          name: /I will use this fork on every device/,
        })
        .check();
      await enable.click();
      await expect(page.getByText(/Enabled\. Use this fork/)).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: 'Switch to tracking budgeting',
        }),
      ).toBeDisabled();

      const fixture = await page.evaluate(async () => {
        const accounts = await window.$send('accounts-get');
        const card = accounts.find(account => account.name === 'Test card');
        const otherCard = accounts.find(
          account => account.name === 'Test other card',
        );
        const { list } = await window.$send('get-categories');
        const expense = list.find(
          category =>
            !category.is_income &&
            category.name !== 'Test card' &&
            category.name !== 'Test other card' &&
            !category.hidden,
        );
        if (!card || !otherCard || !expense) {
          throw new Error('Missing credit-card fixture accounts/categories');
        }
        await window.$send('budget/budget-amount', {
          month: '2017-01',
          category: expense.id,
          amount: 10000,
        });
        await window.$send('transaction-add', {
          id: 'test-purchase',
          account: card.id,
          category: expense.id,
          amount: -6000,
          date: '2017-01-10',
        });
        return {
          cardId: card.id,
          otherCardId: otherCard.id,
          expenseId: expense.id,
        };
      });
      if (viewport.name === 'desktop') {
        await new Navigation(page).goToBudgetPage();
      } else {
        await page.goto('/budget');
      }
      const openCardDetails = async () => {
        const balance =
          viewport.name === 'mobile'
            ? page.getByRole('button', {
                name: 'Open balance menu for Test card category',
                exact: true,
              })
            : page
                .getByRole('button', { name: /Card payment.*60\.00/ })
                .first();
        await balance.click();
        return page.getByTestId('credit-card-details');
      };
      const panel = await openCardDetails();
      await expect(panel).toContainText('Available to pay60.00');
      await expect(panel).toContainText('Debt not covered200.00');
      await page.keyboard.press('Escape');
      await page.reload();
      await expect(await openCardDetails()).toContainText(
        'Available to pay60.00',
      );
      await page.keyboard.press('Escape');

      await page.evaluate(async ({ otherCardId, expenseId }) => {
        await window.$send('transaction-add', {
          id: 'test-other-purchase',
          account: otherCardId,
          category: expenseId,
          amount: -6000,
          date: '2017-01-11',
        });
      }, fixture);
      await expect(
        page
          .getByRole('img', { name: 'Credit overspending', exact: true })
          .first(),
      ).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await page.evaluate(async ({ expenseId }) => {
        await window.$send('budget/budget-amount', {
          month: '2017-01',
          category: expenseId,
          amount: 12000,
        });
      }, fixture);
      await expect(
        page.getByRole('img', { name: 'Credit overspending', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);

      await page.evaluate(async ({ cardId }) => {
        const { list } = await window.$send('get-categories');
        const income = list.find(category => category.is_income);
        if (!income) {
          throw new Error('Missing income category');
        }
        await window.$send('transaction-add', {
          id: 'test-positive-balance',
          account: cardId,
          category: income.id,
          amount: 100000,
          date: '2017-01-20',
        });
      }, fixture);
      await expect(
        page
          .getByRole('img', { name: 'Card payment has excess reserves' })
          .first(),
      ).toBeVisible();
      if (viewport.name === 'desktop') {
        await page
          .getByRole('button', {
            name: /Card payment has excess reserves.*60\.00/,
          })
          .first()
          .click();
      } else {
        await openCardDetails();
      }
      await expect(panel).toContainText('Excess reserve60.00');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('credit-card-payments')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByTestId('budget-table')).toBeVisible();
    } finally {
      await page.close();
    }
  });
}
