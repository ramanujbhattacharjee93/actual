import { theme } from '@actual-app/components/theme';
import { render, screen } from '@testing-library/react';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';
import { envelopeBudget } from '#spreadsheet/bindings';

import { CreditCardBalance } from './CreditCardBalance';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);
let values: Record<string, number | null> = {};
vi.mock('#hooks/useSheetValue', () => ({
  useSheetValue: (binding: string | { name: string }) =>
    values[typeof binding === 'string' ? binding : binding.name] ?? null,
}));

function show({
  balance,
  cash = 0,
  credit = 0,
  debt = 0,
  isPayment = false,
}: {
  balance: number;
  cash?: number;
  credit?: number;
  debt?: number;
  isPayment?: boolean;
}) {
  values = {
    'leftover-food': balance,
    'cash-overspent-food': cash,
    'credit-overspent-food': credit,
    'payment-debt-food': debt,
  };
  const queryClient = createTestQueryClient();
  const store = configureTestAppStore({ queryClient });
  store.dispatch(
    mergeSyncedPrefs({
      'credit-card-budget-v1': JSON.stringify({
        version: 2,
        cards: [
          {
            accountId: 'card',
            paymentCategoryId: isPayment ? 'food' : 'other',
          },
        ],
      }),
    }),
  );
  return render(
    <TestProviders queryClient={queryClient} store={store}>
      <CreditCardBalance
        categoryId="food"
        balance={envelopeBudget.catBalance('food')}
        budgeted={envelopeBudget.catBudgeted('food')}
        carryover={envelopeBudget.catCarryover('food')}
        goal={envelopeBudget.catGoal('food')}
        longGoal={envelopeBudget.catLongGoal('food')}
      />
    </TestProviders>,
  );
}

it('shows credit overspending distinctly from cash overspending', () => {
  show({ balance: -1000, credit: 1000 });
  expect(screen.getByTitle('Credit overspending')).toBeInTheDocument();
  expect(screen.getByTestId('__global!leftover-food')).toHaveStyle({
    color: theme.templateNumberUnderFunded,
  });
});

it('keeps cash overspending red when cash and credit both exceed funding', () => {
  show({ balance: -1500, cash: 500, credit: 1000 });
  expect(screen.getByTitle('Cash overspending')).toBeInTheDocument();
  expect(screen.getByTestId('__global!leftover-food')).toHaveStyle({
    color: theme.budgetNumberNegative,
  });
});

it('shows an underfunded payment without requiring a separate goal', () => {
  show({ balance: 5000, debt: 10000, isPayment: true });
  expect(screen.getByTitle('Card payment is underfunded')).toBeInTheDocument();
  expect(
    screen.getByRole('img', { name: 'Card payment is underfunded' }),
  ).toBeInTheDocument();
  expect(screen.getByTestId('__global!leftover-food')).toHaveStyle({
    color: theme.templateNumberUnderFunded,
  });
});

it('identifies payment overspending instead of labeling it ordinary cash spending', () => {
  show({ balance: -1000, cash: 1000, debt: 10000, isPayment: true });
  expect(
    screen.getByRole('img', { name: 'Payment overspending' }),
  ).toBeInTheDocument();
  expect(screen.getByTestId('__global!leftover-food')).toHaveStyle({
    color: theme.budgetNumberNegative,
  });
});

it('identifies excess payment reserves instead of silently capping them', () => {
  show({ balance: 12000, debt: 10000, isPayment: true });
  expect(
    screen.getByTitle('Card payment has excess reserves'),
  ).toBeInTheDocument();
  expect(screen.getByTestId('__global!leftover-food')).toHaveTextContent(
    '120.00',
  );
});
