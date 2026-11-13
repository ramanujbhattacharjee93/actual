// @ts-strict-ignore
import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Block } from '@actual-app/components/block';
import { ButtonWithLoading } from '@actual-app/components/button';
import { Paragraph } from '@actual-app/components/paragraph';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { importBudget } from '#budgetfiles/budgetfilesSlice';
import { Link } from '#components/common/Link';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { Checkbox } from '#components/forms';
import { ImportProgress } from '#components/modals/manager/ImportProgress';
import { useNavigate } from '#hooks/useNavigate';
import { useDispatch } from '#redux';

export function ImportYNAB5Modal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [error, setError] = useState<string | null>(null);
  const [creditCards, setCreditCards] = useState(true);

  function getErrorMessage(error: string): string {
    switch (error) {
      case 'ynab-card-source':
        return t(
          'The YNAB JSON export is incomplete or invalid. No budget was uploaded.',
        );
      case 'ynab-card-mapping':
        return t(
          'Card payment categories could not be matched to card accounts. Their names must match in the YNAB export.',
        );
      case 'ynab-card-precision':
        return t(
          'The export contains amounts that cannot be represented exactly in minor units. Nothing was imported.',
        );
      case 'ynab-card-reconciliation':
        return t(
          'Imported balances, category amounts, or Ready to Assign did not match YNAB. The trial import was discarded; nothing was uploaded.',
        );
      case 'parse-error':
        return t(
          'Unable to parse file. Please select a JSON file exported from nYNAB.',
        );
      case 'not-ynab5':
        return t(
          'This file is not valid. Please select a JSON file exported from nYNAB.',
        );
      default:
        return t(
          'An unknown error occurred while importing. Please report this as a new issue on GitHub.',
        );
    }
  }

  const [importing, setImporting] = useState(false);

  async function onImport() {
    const res = await window.Actual.openFileDialog({
      properties: ['openFile'],
      filters: [{ name: 'ynab', extensions: ['json'] }],
    });
    if (res) {
      setImporting(true);
      setError(null);
      try {
        await dispatch(
          importBudget({ filepath: res[0], type: 'ynab5', creditCards }),
        ).unwrap();
        void navigate('/budget');
      } catch (err) {
        setError(err.message);
      } finally {
        setImporting(false);
      }
    }
  }

  return (
    <Modal
      name="import-ynab5"
      isDismissable={!importing}
      containerProps={{ style: { width: 400 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Import from nYNAB')}
            rightContent={
              !importing && <ModalCloseButton onPress={() => state.close()} />
            }
          />
          <View style={{ ...styles.smallText, lineHeight: 1.5, marginTop: 20 }}>
            {error && (
              <Block style={{ color: theme.errorText, marginBottom: 15 }}>
                {getErrorMessage(error)}
              </Block>
            )}

            <View
              style={{
                alignItems: 'center',
                '& > div': { lineHeight: '1.7em' },
              }}
            >
              <Paragraph>
                <Trans>
                  <Link
                    variant="external"
                    to="https://actualbudget.org/docs/migration/nynab"
                  >
                    Read here
                  </Link>{' '}
                  for instructions on how to migrate your data from YNAB. You
                  need to export your data as JSON, and that page explains how
                  to do that.
                </Trans>
              </Paragraph>
              <label>
                <Checkbox
                  checked={creditCards}
                  disabled={importing}
                  onChange={event =>
                    setCreditCards(event.currentTarget.checked)
                  }
                />
                <Trans>Use YNAB-style credit-card payment categories</Trans>
              </label>
              <Paragraph>
                {creditCards ? (
                  <Trans>
                    Card accounts and payment allocations are preserved.
                    Balances and historical categories must reconcile before the
                    import completes. Review the local budget before uploading
                    it. Every client must use this fork.
                  </Trans>
                ) : (
                  <Trans>
                    Once you have exported your data, select the file and Actual
                    will import it. Budgets may not match up exactly because
                    things work slightly differently, but you should be able to
                    fix up any problems.
                  </Trans>
                )}
              </Paragraph>
              {!importing && (
                <View>
                  <ButtonWithLoading
                    variant="primary"
                    autoFocus
                    onPress={onImport}
                  >
                    <Trans>Select file...</Trans>
                  </ButtonWithLoading>
                </View>
              )}
              <ImportProgress />
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}
