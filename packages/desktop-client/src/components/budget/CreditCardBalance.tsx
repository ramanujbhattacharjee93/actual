import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import {
  SvgExclamationOutline,
  SvgInformationOutline,
} from '@actual-app/components/icons/v1';
import { SvgCheckCircle1 } from '@actual-app/components/icons/v2';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  CREDIT_CARD_BUDGET_PREF,
  parseCreditCardBudgetConfig,
} from '@actual-app/core/shared/credit-card-budget';

import { useSheetValue } from '#hooks/useSheetValue';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { envelopeBudget } from '#spreadsheet/bindings';

import { BalanceWithCarryover } from './BalanceWithCarryover';

type Props = ComponentProps<typeof BalanceWithCarryover> & {
  categoryId: string;
};

export function CreditCardBalance({ categoryId, ...props }: Props) {
  const [value] = useSyncedPref(CREDIT_CARD_BUDGET_PREF);
  let isPayment = false;
  let native = false;
  try {
    const config = value ? parseCreditCardBudgetConfig(value) : undefined;
    native = config?.version === 2;
    isPayment = Boolean(
      config?.cards.some(card => card.paymentCategoryId === categoryId),
    );
  } catch {
    // The budget guard handles incompatible configurations before showing totals.
  }
  return native && !props.isIncome ? (
    <NativeBalance categoryId={categoryId} isPayment={isPayment} {...props} />
  ) : (
    <BalanceWithCarryover {...props} />
  );
}

function NativeBalance({
  categoryId,
  isPayment,
  ...props
}: Props & { isPayment: boolean }) {
  const { t } = useTranslation();
  const credit =
    useSheetValue<'envelope-budget', 'credit-overspent'>(
      envelopeBudget.catCreditOverspent(categoryId),
    ) ?? 0;
  const cash =
    useSheetValue<'envelope-budget', 'cash-overspent'>(
      envelopeBudget.catCashOverspent(categoryId),
    ) ?? 0;
  const debt =
    useSheetValue<'envelope-budget', 'payment-debt'>(
      envelopeBudget.catPaymentDebt(categoryId),
    ) ?? 0;
  const balance =
    useSheetValue<'envelope-budget', 'leftover'>(
      envelopeBudget.catBalance(categoryId),
    ) ?? 0;
  const status =
    cash > 0
      ? isPayment
        ? t('Payment overspending')
        : t('Cash overspending')
      : credit > 0
        ? t('Credit overspending')
        : isPayment && balance < debt
          ? t('Card payment is underfunded')
          : isPayment && balance > debt
            ? t('Card payment has excess reserves')
            : isPayment
              ? t('Card payment is fully funded')
              : undefined;
  const warning = cash > 0 || credit > 0 || (isPayment && balance < debt);
  const Icon = warning
    ? SvgExclamationOutline
    : isPayment && balance > debt
      ? SvgInformationOutline
      : SvgCheckCircle1;
  return (
    <View
      title={status}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 4,
        minWidth: 0,
        maxWidth: '100%',
      }}
    >
      {status && (
        <Icon
          role="img"
          aria-label={status}
          width={12}
          height={12}
          style={{
            flexShrink: 0,
            color:
              cash > 0
                ? theme.budgetNumberNegative
                : warning
                  ? theme.templateNumberUnderFunded
                  : theme.pageTextSubdued,
          }}
        />
      )}
      <BalanceWithCarryover
        {...props}
        amountStyle={() => ({
          ...(cash > 0 && { color: theme.budgetNumberNegative }),
          ...(cash === 0 &&
            (credit > 0 || (isPayment && balance < debt)) && {
              color: theme.templateNumberUnderFunded,
            }),
          ...(isPayment &&
            balance >= debt &&
            balance > 0 && { color: theme.budgetNumberPositive }),
        })}
      />
    </View>
  );
}
