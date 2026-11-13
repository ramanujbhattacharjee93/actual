import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { spacing } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import {
  CREDIT_CARD_BUDGET_PREF,
  parseCreditCardBudgetConfig,
} from '@actual-app/core/shared/credit-card-budget';
import type { CreditCardBudgetConfig } from '@actual-app/core/shared/credit-card-budget';
import { useQueryClient } from '@tanstack/react-query';

import { budgetBoundsQueries, categoryQueries } from '#budget';
import { Checkbox } from '#components/forms';
import { useAccounts } from '#hooks/useAccounts';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { loadPrefs } from '#prefs/prefsSlice';
import { useDispatch } from '#redux';

import { SettingsRow } from './SettingsRow';

export function CreditCardBudgetSettings() {
  const { t } = useTranslation();
  const [config] = useSyncedPref(CREDIT_CARD_BUDGET_PREF);
  let parsed: CreditCardBudgetConfig | undefined;
  try {
    parsed = config ? parseCreditCardBudgetConfig(config) : undefined;
  } catch {
    // The budget guard shows incompatible configurations without changing them.
  }
  const native = parsed?.version === 2;
  const legacy = config !== undefined && !native;
  const [budgetType = 'envelope'] = useSyncedPref('budgetType');
  const { data: accounts = [] } = useAccounts();
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const queryClient = useQueryClient();
  const dispatch = useDispatch();

  async function enable() {
    setLoading(true);
    setError(false);
    try {
      if (native) {
        await send('budget/add-credit-card', {
          accountId: accountIds[0],
          forkOnlyAcknowledged: acknowledged,
          paymentGroupName: t('Credit Card Payments'),
        });
      } else {
        await send('budget/enable-credit-cards', {
          accountIds,
          paymentGroupName: t('Credit Card Payments'),
          forkOnlyAcknowledged: acknowledged,
        });
      }
      setAccountIds([]);
      await dispatch(loadPrefs()).unwrap();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: categoryQueries.all() }),
        queryClient.invalidateQueries({ queryKey: budgetBoundsQueries.all() }),
      ]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SettingsRow
      title={t('Credit-card payment categories')}
      description={
        <Trans>
          Funded purchases move money to a payment category for each card.
          Assign extra money there to pay down existing debt. Positive card
          balances behave like cash. Use the card-aware YNAB JSON import to
          preserve existing account and payment-category history.
        </Trans>
      }
    >
      {legacy ? (
        <Text>
          <Trans>
            This budget retains version 1 demo accounting. Its history has not
            been reinterpreted. Create a new budget or use the card-aware YNAB
            import for native accounting; do not change the version flag
            manually.
          </Trans>
        </Text>
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Text>
            {native ? (
              <Trans>
                Enabled. Use this fork on every device and API client. To add
                another card, create its account with only a starting balance
                and select it below.
              </Trans>
            ) : (
              <Trans>
                Start a new envelope budget and add all your card accounts
                first. Only starting balances are allowed before enabling.
              </Trans>
            )}
          </Text>
          {accounts
            .filter(
              account =>
                !account.closed &&
                !account.offbudget &&
                !parsed?.cards.some(card => card.accountId === account.id),
            )
            .map(account => (
              <label key={account.id}>
                <Checkbox
                  checked={accountIds.includes(account.id)}
                  disabled={loading}
                  onChange={event =>
                    setAccountIds(
                      event.currentTarget.checked
                        ? native
                          ? [account.id]
                          : [...accountIds, account.id]
                        : accountIds.filter(id => id !== account.id),
                    )
                  }
                />
                {account.name}
              </label>
            ))}
          <label>
            <Checkbox
              checked={acknowledged}
              disabled={loading}
              onChange={event => setAcknowledged(event.currentTarget.checked)}
            />
            <Trans>
              I will use this fork on every device and API client. Stock Actual
              clients do not understand these payment categories.
            </Trans>
          </label>
          <ButtonWithLoading
            isLoading={loading}
            isDisabled={
              !acknowledged ||
              accountIds.length === 0 ||
              budgetType !== 'envelope'
            }
            onPress={enable}
          >
            {native ? (
              <Trans>Add card payment category</Trans>
            ) : (
              <Trans>Enable credit-card payment categories</Trans>
            )}
          </ButtonWithLoading>
          {error && (
            <Text role="alert" style={{ color: theme.errorText }}>
              <Trans>
                Setup failed. Choose a new card account with only a starting
                balance. Initial enablement requires a new envelope budget; use
                the YNAB importer for existing YNAB history.
              </Trans>
            </Text>
          )}
        </View>
      )}
    </SettingsRow>
  );
}
