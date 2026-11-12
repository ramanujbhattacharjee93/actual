import type { CreditCardBudgetState } from '@actual-app/core/shared/credit-card-budget';
import { act, render, screen, waitFor } from '@testing-library/react';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { initServer } from '#mocks/connection';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { CreditCardBudgetGuard } from './CreditCardBudgetGuard';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

let revision = 'first';
vi.mock('#hooks/useSheetValue', () => ({
  useSheetValue: () => revision,
}));

function readyState(month = '2017-01'): CreditCardBudgetState {
  return {
    status: 'ready',
    month,
    categories: {},
    cards: [
      {
        accountId: 'card',
        paymentCategoryId: 'payment',
        balance: -10000,
        fundedSpending: 6000,
        payments: 0,
        paymentAvailable: 6000,
        unfundedDebt: 4000,
        paymentShortfall: 0,
        excessReserve: 0,
      },
    ],
    income: 100000,
    fromLastMonth: 0,
    lastMonthOverspent: 0,
    availableFunds: 100000,
    totalBudgeted: -6000,
    totalSpent: -6000,
    totalAvailable: 6000,
    buffered: 0,
    toBudget: 94000,
    cashOverspent: 0,
    cashBalance: 100000,
  };
}

function mount({ enabled = true, numMonths = 1 } = {}) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(
    ['accounts', 'lists'],
    [{ id: 'card', name: 'Test card', offbudget: false, closed: false }],
  );
  const store = configureTestAppStore({ queryClient });
  if (enabled) {
    store.dispatch(mergeSyncedPrefs({ 'credit-card-budget-v1': 'enabled' }));
  }
  const tree = () => (
    <TestProviders queryClient={queryClient} store={store}>
      <CreditCardBudgetGuard month="2017-01" numMonths={numMonths}>
        <div>Budget table</div>
      </CreditCardBudgetGuard>
    </TestProviders>
  );
  const result = render(tree());
  return { ...result, rerenderGuard: () => result.rerender(tree()) };
}

describe('credit-card budget guard', () => {
  beforeEach(() => {
    revision = 'first';
    initServer({
      'accounts-get': () => [{ id: 'card', name: 'Test card' }],
      'budget/credit-card-state': () => readyState(),
    });
  });

  it('leaves ordinary budget content unchanged', () => {
    mount({ enabled: false });
    expect(screen.getByText('Budget table')).toBeInTheDocument();
    expect(
      screen.queryByTestId('credit-card-payments'),
    ).not.toBeInTheDocument();
  });

  it('shows reserves separately from uncovered debt and renders the editable budget', async () => {
    mount();
    const panel = await screen.findByTestId('credit-card-payments');
    expect(panel).toHaveTextContent('Available to pay 60.00');
    expect(panel).toHaveTextContent('Debt not covered 40.00');
    expect(await screen.findByText('Test card')).toBeInTheDocument();
    expect(screen.getByText('Budget table')).toBeInTheDocument();
  });

  it('hides all calculated amounts and the budget when an earlier month is blocked', async () => {
    initServer({
      'budget/credit-card-state': () => ({
        status: 'blocked',
        month: '2016-12',
        issues: [{ code: 'positive-card-balance', accountId: 'card' }],
      }),
    });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('2016-12');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Positive card balances',
    );
    expect(screen.queryByText('Budget table')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('credit-card-payments'),
    ).not.toBeInTheDocument();
  });

  it('does not leave stale payment amounts visible while a recalculation is loading', async () => {
    const view = mount();
    await screen.findByTestId('credit-card-payments');
    let finish: ((state: CreditCardBudgetState) => void) | undefined;
    initServer({
      'budget/credit-card-state': () =>
        new Promise<CreditCardBudgetState>(resolve => {
          finish = resolve;
        }),
    });
    revision = 'second';
    view.rerenderGuard();
    await waitFor(() => {
      expect(
        screen.queryByTestId('credit-card-payments'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Budget table')).not.toBeInTheDocument();
    });
    await act(async () => {
      finish?.({
        status: 'blocked',
        month: '2017-01',
        issues: [{ code: 'invalid-amount' }],
      });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'invalid or too large',
    );
  });

  it('guards every displayed month rather than showing invalid future columns', async () => {
    initServer({
      'accounts-get': () => [],
      'budget/credit-card-state': args => {
        if (
          typeof args === 'object' &&
          args &&
          'month' in args &&
          args.month === '2017-02'
        ) {
          return {
            status: 'blocked',
            month: '2017-02',
            issues: [{ code: 'invalid-mapping' }],
          };
        }
        return readyState();
      },
    });
    mount({ numMonths: 2 });
    expect(await screen.findByRole('alert')).toHaveTextContent('2017-02');
    expect(screen.queryByText('Budget table')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('credit-card-payments'),
    ).not.toBeInTheDocument();
  });
});
