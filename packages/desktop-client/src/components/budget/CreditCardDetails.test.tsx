import { render, screen } from '@testing-library/react';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { CreditCardDetails } from './CreditCardDetails';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);
let state = '';
vi.mock('#hooks/useSheetValue', () => ({ useSheetValue: () => state }));

function show({
  enabled = true,
  version = 2,
  categoryId = 'payment',
  blocked = false,
} = {}) {
  state = JSON.stringify({
    status: blocked ? 'blocked' : 'ready',
    cards: [
      {
        paymentCategoryId: 'payment',
        balance: -18000,
        paymentAvailable: 3000,
        fundedSpending: 6000,
        payments: 8000,
        unfundedDebt: 15000,
        paymentShortfall: 0,
        excessReserve: 0,
        interestCharged: 100,
      },
    ],
    categories: {
      food: { cashOverspent: 100, creditOverspent: 200 },
      travel: { cashOverspent: 0, creditOverspent: 0 },
    },
  });
  const queryClient = createTestQueryClient();
  const store = configureTestAppStore({ queryClient });
  if (enabled) {
    store.dispatch(
      mergeSyncedPrefs({
        'credit-card-budget-v1': JSON.stringify({
          version,
          cards: [{ accountId: 'card', paymentCategoryId: 'payment' }],
        }),
      }),
    );
  }
  render(
    <TestProviders queryClient={queryClient} store={store}>
      <CreditCardDetails categoryId={categoryId}>
        <div>Existing balance header</div>
      </CreditCardDetails>
    </TestProviders>,
  );
}

it('puts payment funding and debt details in the existing balance menu', () => {
  show();
  const details = screen.getByTestId('credit-card-details');
  expect(details).toHaveTextContent('Available to pay30.00');
  expect(details).toHaveTextContent('Card debt180.00');
  expect(details).toHaveTextContent('Funded purchases60.00');
  expect(details).toHaveTextContent('Payments this month80.00');
  expect(details).toHaveTextContent('Debt not covered150.00');
  expect(details).toHaveTextContent('Debt-only interest1.00');
  expect(screen.queryByText('Existing balance header')).not.toBeInTheDocument();
});

it('preserves the demo-only warning for legacy card budgets', () => {
  show({ version: 1 });
  expect(screen.getByTestId('credit-card-details')).toHaveTextContent(
    'Demo only.',
  );
});

it('explains both kinds of overspending without removing the ordinary category header', () => {
  show({ categoryId: 'food' });
  expect(screen.getByTestId('credit-card-details')).toHaveTextContent(
    'Cash overspending1.00',
  );
  expect(screen.getByTestId('credit-card-details')).toHaveTextContent(
    'Credit overspending2.00',
  );
  expect(screen.getByText('Existing balance header')).toBeInTheDocument();
});

it.each([{ enabled: false }, { categoryId: 'travel' }])(
  'preserves the existing header when card details are not needed: %o',
  options => {
    show(options);
    expect(screen.getByText('Existing balance header')).toBeInTheDocument();
    expect(screen.queryByTestId('credit-card-details')).not.toBeInTheDocument();
  },
);

it('never shows cached financial details when the month is blocked', () => {
  show({ blocked: true });
  expect(screen.queryByTestId('credit-card-details')).not.toBeInTheDocument();
  expect(screen.queryByText('Existing balance header')).not.toBeInTheDocument();
});
