import { useState } from 'react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { spacing } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { CREDIT_CARD_BUDGET_PREF } from '@actual-app/core/shared/credit-card-budget';
import type {
  CreditCardBudgetIssue,
  CreditCardBudgetReady,
} from '@actual-app/core/shared/credit-card-budget';
import * as monthUtils from '@actual-app/core/shared/months';
import { useQuery } from '@tanstack/react-query';

import { FinancialText } from '#components/FinancialText';
import { useAccounts } from '#hooks/useAccounts';
import { useCategories } from '#hooks/useCategories';
import { useFormat } from '#hooks/useFormat';
import { SheetNameProvider, useSheetName } from '#hooks/useSheetName';
import { useSheetValue } from '#hooks/useSheetValue';
import { useSyncedPref } from '#hooks/useSyncedPref';

export function CreditCardBudgetGuard({
  month,
  numMonths = 1,
  showPayments = true,
  children,
}: {
  month: string;
  numMonths?: number;
  showPayments?: boolean;
  children: ReactNode;
}) {
  const [config] = useSyncedPref(CREDIT_CARD_BUDGET_PREF);
  const { sheetName: parentSheet } = useSheetName<
    'envelope-budget',
    'credit-card-state'
  >('credit-card-state');
  if (config === undefined) {
    return children;
  }
  return (
    <SheetNameProvider name={monthUtils.sheetForMonth(month)}>
      <MonthGuard month={month}>
        {state => {
          const content = (
            <SheetNameProvider name={parentSheet}>
              {showPayments && <PaymentCategories state={state} />}
              {children}
            </SheetNameProvider>
          );
          return numMonths > 1 ? (
            <CreditCardBudgetGuard
              month={monthUtils.nextMonth(month)}
              numMonths={numMonths - 1}
              showPayments={false}
            >
              {content}
            </CreditCardBudgetGuard>
          ) : (
            content
          );
        }}
      </MonthGuard>
    </SheetNameProvider>
  );
}

function MonthGuard({
  month,
  children,
}: {
  month: string;
  children: (state: CreditCardBudgetReady) => ReactNode;
}) {
  const { t } = useTranslation();
  const revision = useSheetValue<'envelope-budget', 'credit-card-state'>(
    'credit-card-state',
  );
  const { data: state, isError } = useQuery({
    queryKey: ['credit-card-budget', month, revision],
    queryFn: () => send('budget/credit-card-state', { month }),
    staleTime: Infinity,
    gcTime: 0,
  });
  const messages: Record<CreditCardBudgetIssue['code'], string> = {
    'invalid-configuration': t(
      'Unsupported credit-card mode or configuration.',
    ),
    'invalid-amount': t('A financial amount is invalid or too large.'),
    'unbalanced-cash': t(
      'Calculated envelopes do not match cash accounts. Amounts are hidden.',
    ),
    'invalid-split': t('Fix an invalid split transaction.'),
    'invalid-mapping': t(
      'A mapped card or payment category was removed or changed.',
    ),
    'positive-card-balance': t('Positive card balances are not supported yet.'),
    'ambiguous-card-funding': t(
      'Fully fund a category shared by multiple cards; funding priority is not defined yet.',
    ),
    'unsupported-transfer': t(
      'Review card transfers. Cash advances, card-to-card transfers, split payments, and mismatched payment pairs are not supported yet.',
    ),
    'uncategorized-spending': t(
      'Categorize transactions before using these totals.',
    ),
    'payment-category-transaction': t(
      'Payments must be account transfers, not transactions categorized to a payment category.',
    ),
    'unsupported-carryover': t(
      'Turn off negative-balance or income carryover; credit-card mode rolls positive balances forward automatically.',
    ),
  };
  if (isError || state?.status === 'blocked') {
    return (
      <View
        role="alert"
        style={{ padding: spacing.md, gap: spacing.sm, color: theme.errorText }}
      >
        <Text>
          <Trans>
            Credit-card budget blocked. No payment amounts are shown.
          </Trans>
        </Text>
        {state?.status === 'blocked' && (
          <>
            <Text>
              <Trans>
                Review transactions and allocations in {state.month}.
              </Trans>
            </Text>
            {[...new Set(state.issues.map(issue => issue.code))].map(code => (
              <Text key={code}>{messages[code]}</Text>
            ))}
            {[
              ...new Set(
                state.issues
                  .filter(issue => issue.code === 'ambiguous-card-funding')
                  .map(issue => issue.categoryId),
              ),
            ].map(categoryId =>
              categoryId ? (
                <AllocationEditor
                  key={categoryId}
                  month={state.month}
                  categoryId={categoryId}
                />
              ) : null,
            )}
          </>
        )}
      </View>
    );
  }
  if (!state || state.status !== 'ready') {
    return (
      <Text role="status" style={{ padding: spacing.md }}>
        <Trans>Calculating credit-card budget...</Trans>
      </Text>
    );
  }
  return children(state);
}

function AllocationEditor({
  month,
  categoryId,
}: {
  month: string;
  categoryId: string;
}) {
  const { data: categories } = useCategories();
  const format = useFormat();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const { data: assignments } = useQuery({
    queryKey: ['credit-card-assignments', month],
    queryFn: () => send('budget/credit-card-assignments', { month }),
    staleTime: 0,
  });
  const category = categories?.list.find(
    category => category.id === categoryId,
  );
  const assigned = assignments?.find(
    row => row.categoryId === categoryId,
  )?.assigned;
  const parsed = value === '' ? null : format.fromEdit(value, null);
  return (
    <View style={{ gap: spacing.xs }}>
      <label htmlFor={`credit-card-assignment-${categoryId}`}>
        <Trans>Assigned to {category?.name}</Trans>
      </label>
      <Input
        id={`credit-card-assignment-${categoryId}`}
        value={value}
        placeholder={
          assigned === undefined ? '' : format(assigned, 'financial')
        }
        onChangeValue={setValue}
        disabled={saving}
        style={{ maxWidth: 200 }}
      />
      <ButtonWithLoading
        isLoading={saving}
        isDisabled={parsed === null}
        onPress={async () => {
          if (parsed === null) {
            return;
          }
          setSaving(true);
          setFailed(false);
          try {
            await send('budget/budget-amount', {
              month,
              category: categoryId,
              amount: parsed,
            });
          } catch {
            setFailed(true);
          } finally {
            setSaving(false);
          }
        }}
      >
        <Trans>Update assigned amount</Trans>
      </ButtonWithLoading>
      {failed && (
        <Text>
          <Trans>Could not update the allocation.</Trans>
        </Text>
      )}
    </View>
  );
}

function PaymentCategories({ state }: { state: CreditCardBudgetReady }) {
  const { data: accounts = [] } = useAccounts();
  const format = useFormat();
  return (
    <View
      data-testid="credit-card-payments"
      style={{ padding: spacing.sm, gap: spacing.xs, flexShrink: 0 }}
    >
      <Text>
        <Trans>Experimental credit-card payments: {state.month}</Trans>
      </Text>
      <Text>
        <Trans>
          Demo only. Assign extra debt payments in the matching payment category
          below. These amounts are not authorization to pay.
        </Trans>
      </Text>
      {state.cards.map(card => (
        <View key={card.accountId} style={{ gap: spacing.xs }}>
          <Text style={{ fontWeight: 600 }}>
            {accounts.find(account => account.id === card.accountId)?.name}
          </Text>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}
          >
            <Text>
              <Trans>Available to pay</Trans>{' '}
              <FinancialText>
                {format(card.paymentAvailable, 'financial')}
              </FinancialText>
            </Text>
            {card.unfundedDebt > 0 && (
              <Text>
                <Trans>Debt not covered</Trans>{' '}
                <FinancialText>
                  {format(card.unfundedDebt, 'financial')}
                </FinancialText>
              </Text>
            )}
            {card.paymentShortfall > 0 && (
              <Text style={{ color: theme.errorText }}>
                <Trans>Payment overspending</Trans>{' '}
                <FinancialText>
                  {format(card.paymentShortfall, 'financial')}
                </FinancialText>
              </Text>
            )}
            {card.excessReserve > 0 && (
              <Text>
                <Trans>Excess reserve</Trans>{' '}
                <FinancialText>
                  {format(card.excessReserve, 'financial')}
                </FinancialText>
              </Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}
