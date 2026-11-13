import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { spacing } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { CREDIT_CARD_BUDGET_PREF } from '@actual-app/core/shared/credit-card-budget';
import type { CreditCardBudgetState } from '@actual-app/core/shared/credit-card-budget';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { useFormat } from '#hooks/useFormat';
import { useSheetValue } from '#hooks/useSheetValue';
import { useSyncedPref } from '#hooks/useSyncedPref';

type Props = { categoryId: string; children?: ReactNode };

export function CreditCardDetails(props: Props) {
  const [config] = useSyncedPref(CREDIT_CARD_BUDGET_PREF);
  return config ? <CategoryDetails {...props} /> : props.children;
}

function CategoryDetails({ categoryId, children }: Props) {
  const { t } = useTranslation();
  const value = useSheetValue<'envelope-budget', 'credit-card-state'>(
    'credit-card-state',
  );
  const [config] = useSyncedPref(CREDIT_CARD_BUDGET_PREF);
  let state: CreditCardBudgetState | undefined;
  let legacy = false;
  try {
    state = typeof value === 'string' ? JSON.parse(value) : undefined;
    legacy = Boolean(config && JSON.parse(config).version === 1);
  } catch {
    // The month guard handles invalid configurations and hides financial totals.
  }
  if (state?.status !== 'ready') {
    return null;
  }
  const card = state.cards.find(card => card.paymentCategoryId === categoryId);
  const category = state.categories[categoryId];
  if (!card && !category?.cashOverspent && !category?.creditOverspent) {
    return children;
  }
  return (
    <>
      <View
        data-testid="credit-card-details"
        style={{
          padding: spacing.sm,
          gap: spacing.xs,
          minWidth: 220,
          borderBottom: `1px solid ${theme.menuBorder}`,
        }}
      >
        <Text style={{ fontWeight: 600, fontSize: 13 }}>
          {card ? (
            <Trans>Credit-card payment</Trans>
          ) : (
            <Trans>Overspending</Trans>
          )}
        </Text>
        {card ? (
          <>
            <Detail
              label={t('Available to pay')}
              amount={card.paymentAvailable}
            />
            <Detail
              label={t('Card debt')}
              amount={Math.max(0, -card.balance)}
            />
            <Detail
              label={t('Funded purchases')}
              amount={card.fundedSpending}
            />
            <Detail label={t('Payments this month')} amount={card.payments} />
            {card.unfundedDebt > 0 && (
              <Detail
                label={t('Debt not covered')}
                amount={card.unfundedDebt}
                color={theme.templateNumberUnderFunded}
              />
            )}
            {card.paymentShortfall > 0 && (
              <Detail
                label={t('Payment overspending')}
                amount={card.paymentShortfall}
                color={theme.budgetNumberNegative}
              />
            )}
            {card.excessReserve > 0 && (
              <Detail label={t('Excess reserve')} amount={card.excessReserve} />
            )}
            {(card.interestCharged ?? 0) > 0 && (
              <Detail
                label={t('Debt-only interest')}
                amount={card.interestCharged ?? 0}
              />
            )}
            <Text
              style={{
                fontSize: 12,
                color: theme.pageTextLight,
                maxWidth: 260,
              }}
            >
              {legacy ? (
                <Trans>
                  Demo only. These amounts are not authorization to pay.
                </Trans>
              ) : (
                <Trans>
                  Funded purchases move money here automatically. Budget extra
                  to cover existing debt.
                </Trans>
              )}
            </Text>
          </>
        ) : (
          <>
            {category.cashOverspent > 0 && (
              <Detail
                label={t('Cash overspending')}
                amount={category.cashOverspent}
                color={theme.budgetNumberNegative}
              />
            )}
            {category.creditOverspent > 0 && (
              <Detail
                label={t('Credit overspending')}
                amount={category.creditOverspent}
                color={theme.templateNumberUnderFunded}
              />
            )}
            <Text
              style={{
                fontSize: 12,
                color: theme.pageTextLight,
                maxWidth: 260,
              }}
            >
              <Trans>
                Cover overspending to keep your budget and card payments funded.
              </Trans>
            </Text>
          </>
        )}
      </View>
      {!card && children}
    </>
  );
}

function Detail({
  label,
  amount,
  color,
}: {
  label: string;
  amount: number;
  color?: string;
}) {
  const format = useFormat();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: spacing.md,
        fontSize: 13,
      }}
    >
      <Text>{label}</Text>
      <PrivacyFilter>
        <FinancialText style={{ color, flexShrink: 0 }}>
          {format(amount, 'financial')}
        </FinancialText>
      </PrivacyFilter>
    </View>
  );
}
