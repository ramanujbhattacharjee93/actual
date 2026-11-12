import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { spacing } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { CREDIT_CARD_BUDGET_PREF } from '@actual-app/core/shared/credit-card-budget';
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
      await send('budget/enable-credit-cards', {
        accountIds,
        paymentGroupName: t('Credit Card Payments'),
        forkOnlyAcknowledged: acknowledged,
      });
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
      title={t('Credit-card payment categories (experimental)')}
      description={
        <Trans>
          Demo budgets only. Funded purchases move money to a payment category
          for each card. Assign extra money there to pay down existing debt.
          This changes budget accounting and is not ready for a YNAB migration.
        </Trans>
      }
    >
      {config !== undefined ? (
        <Text>
          <Trans>
            Enabled. Use only this fork on every device and API client. Mappings
            are fixed; restore a pre-enablement backup to return to ordinary
            Actual budgeting.
          </Trans>
        </Text>
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Text>
            <Trans>
              Start a new envelope budget and add all your card accounts first.
              Only starting balances are allowed before enabling.
            </Trans>
          </Text>
          {accounts
            .filter(account => !account.closed && !account.offbudget)
            .map(account => (
              <label key={account.id}>
                <Checkbox
                  checked={accountIds.includes(account.id)}
                  disabled={loading}
                  onChange={event =>
                    setAccountIds(
                      event.currentTarget.checked
                        ? [...accountIds, account.id]
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
              This is a disposable demo budget. I will not open it with stock
              Actual clients or use it for real payment decisions.
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
            <Trans>Enable credit-card payment categories</Trans>
          </ButtonWithLoading>
          {error && (
            <Text role="alert" style={{ color: theme.errorText }}>
              <Trans>
                Setup failed. Use a new envelope budget with only starting
                balances, select card accounts, and make sure no Credit Card
                Payments group already exists.
              </Trans>
            </Text>
          )}
        </View>
      )}
    </SettingsRow>
  );
}
