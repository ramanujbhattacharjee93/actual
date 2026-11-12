import { describe, expect, it } from 'vitest';

import { calculateCreditCardReserves } from './credit-card-reserves';
import type {
  CreditCardReserveCard,
  CreditCardReserveCategory,
} from './credit-card-reserves';

const card: CreditCardReserveCard = {
  accountId: 'card',
  openingBalance: 0,
  balance: -10000,
  openingPaymentAvailable: 0,
  assigned: 0,
  payments: 0,
};
const groceries: CreditCardReserveCategory = {
  categoryId: 'groceries',
  availableBeforeSpending: 10000,
  cashSpent: 0,
  cardSpending: [{ accountId: 'card', amount: 10000 }],
};

function preview(
  cards: CreditCardReserveCard[] = [card],
  categories: CreditCardReserveCategory[] = [groceries],
) {
  const result = calculateCreditCardReserves({ cards, categories });
  if (result.status !== 'preview') {
    throw new Error(
      `Unexpected blocked preview: ${JSON.stringify(result.issues)}`,
    );
  }
  return result;
}

describe('credit-card reserve projection', () => {
  it('moves funded spending out of a category and into the payment reserve', () => {
    const result = preview();

    expect(result.categories[0]).toEqual({
      categoryId: 'groceries',
      balance: 0,
      fundedSpending: 10000,
      unfundedSpending: 0,
    });
    expect(result.cards[0]).toEqual({
      accountId: 'card',
      balance: -10000,
      fundedSpending: 10000,
      paymentAvailable: 10000,
      unfundedDebt: 0,
      paymentShortfall: 0,
      excessReserve: 0,
    });
  });

  it('leaves unfunded purchases as debt instead of inventing payment funds', () => {
    const result = preview(
      [card],
      [{ ...groceries, availableBeforeSpending: 4000 }],
    );

    expect(result.cards[0]).toMatchObject({
      paymentAvailable: 4000,
      unfundedDebt: 6000,
    });
    expect(result.categories[0]).toMatchObject({
      balance: -6000,
      unfundedSpending: 6000,
    });
  });

  it('gives cash spending priority over card reserves in the same category', () => {
    const result = preview(
      [{ ...card, balance: -8000 }],
      [
        {
          ...groceries,
          cashSpent: 5000,
          cardSpending: [{ accountId: 'card', amount: 8000 }],
        },
      ],
    );

    expect(result.cards[0]).toMatchObject({
      paymentAvailable: 5000,
      unfundedDebt: 3000,
    });
    expect(result.categories[0].balance).toBe(-3000);
  });

  it('funds purchases after a cash refund and never funds from a negative category', () => {
    expect(
      preview(
        [card],
        [{ ...groceries, availableBeforeSpending: 5000, cashSpent: -5000 }],
      ).cards[0].paymentAvailable,
    ).toBe(10000);
    expect(
      preview([card], [{ ...groceries, availableBeforeSpending: -1000 }])
        .cards[0].paymentAvailable,
    ).toBe(0);
  });

  it('tracks old debt, explicit debt-paydown assignments, and partial payments', () => {
    const result = preview(
      [
        {
          ...card,
          openingBalance: -50000,
          balance: -45000,
          openingPaymentAvailable: 10000,
          assigned: 5000,
          payments: 15000,
        },
      ],
      [groceries],
    );

    expect(result.cards[0]).toMatchObject({
      paymentAvailable: 10000,
      unfundedDebt: 35000,
      paymentShortfall: 0,
    });
  });

  it('exposes an underfunded payment rather than silently clamping its reserve', () => {
    const result = preview(
      [
        {
          ...card,
          openingBalance: -10000,
          balance: -5000,
          payments: 5000,
        },
      ],
      [],
    );

    expect(result.cards[0]).toMatchObject({
      paymentAvailable: -5000,
      paymentShortfall: 5000,
      unfundedDebt: 5000,
    });
  });

  it('keeps excess reserves visible after a reward reduces existing debt', () => {
    const result = preview(
      [
        {
          ...card,
          openingBalance: -10000,
          balance: -9000,
          openingPaymentAvailable: 10000,
        },
      ],
      [],
    );

    expect(result.cards[0]).toMatchObject({
      paymentAvailable: 10000,
      excessReserve: 1000,
      unfundedDebt: 0,
    });
  });

  it('handles a same-month refund without reserving the refunded spending', () => {
    const result = preview(
      [{ ...card, balance: -6000 }],
      [
        {
          ...groceries,
          cardSpending: [
            { accountId: 'card', amount: 10000 },
            { accountId: 'card', amount: -4000 },
          ],
        },
      ],
    );

    expect(result.cards[0].paymentAvailable).toBe(6000);
    expect(result.categories[0].balance).toBe(4000);
  });

  it('reserves the exact minor units for multiple fully funded cards', () => {
    const result = preview(
      [
        { ...card, balance: -10001 },
        { ...card, accountId: 'second-card', balance: -9999 },
      ],
      [
        {
          ...groceries,
          availableBeforeSpending: 20000,
          cardSpending: [
            { accountId: 'card', amount: 10001 },
            { accountId: 'second-card', amount: 9999 },
          ],
        },
      ],
    );

    expect(result.cards.map(item => item.paymentAvailable)).toEqual([
      10001, 9999,
    ]);
    expect(result.categories[0].balance).toBe(0);
  });

  it('carries payment reserves into the next month without reserving twice', () => {
    const first = preview().cards[0];
    const second = preview(
      [
        {
          ...card,
          openingBalance: first.balance,
          balance: 0,
          openingPaymentAvailable: first.paymentAvailable,
          payments: 10000,
        },
      ],
      [],
    );

    expect(second.cards[0]).toMatchObject({
      paymentAvailable: 0,
      fundedSpending: 0,
      unfundedDebt: 0,
    });
  });

  it.each([
    {
      cards: [card, { ...card, accountId: 'second-card' }],
      categories: [
        {
          ...groceries,
          cardSpending: [
            { accountId: 'card', amount: 10000 },
            { accountId: 'second-card', amount: 10000 },
          ],
        },
      ],
      code: 'ambiguous-card-funding',
    },
    {
      cards: [card],
      categories: [
        {
          ...groceries,
          cardSpending: [{ accountId: 'card', amount: -1000 }],
        },
      ],
      code: 'prior-month-refund',
    },
    {
      cards: [{ ...card, balance: 1000 }],
      categories: [],
      code: 'positive-card-balance',
    },
    {
      cards: [{ ...card, openingBalance: 1000 }],
      categories: [],
      code: 'positive-card-balance',
    },
  ])('blocks unsupported $code instead of returning payment amounts', input => {
    const result = calculateCreditCardReserves(input);

    expect(result).toMatchObject({
      status: 'blocked',
      issues: [{ code: input.code }],
    });
    expect(result).not.toHaveProperty('cards');
  });

  it('recomputes assignments without changing the input or retaining prior results', () => {
    const input = {
      cards: [Object.freeze({ ...card })],
      categories: [Object.freeze({ ...groceries })],
    };
    const first = calculateCreditCardReserves(input);

    expect(
      preview([card], [{ ...groceries, availableBeforeSpending: 3000 }])
        .cards[0].paymentAvailable,
    ).toBe(3000);
    expect(calculateCreditCardReserves(input)).toEqual(first);
  });

  it.each([
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid financial amount: %s', amount => {
    expect(() => preview([{ ...card, assigned: amount }])).toThrow(
      'safe integer minor units',
    );
  });

  it('rejects overflow, unknown accounts, and duplicate identifiers', () => {
    expect(() =>
      preview([{ ...card, assigned: Number.MAX_SAFE_INTEGER }]),
    ).toThrow('safe integer minor units');
    expect(() => preview([], [groceries])).toThrow('unknown card');
    expect(() => preview([card, card])).toThrow('unique, nonempty IDs');
    expect(() => preview([card], [groceries, groceries])).toThrow(
      'unique, nonempty IDs',
    );
  });
});
