<p align="center">
  <img src="/demo.png" alt="Actualbudget" />
</p>

## Getting Started

### This fork: native YNAB-style credit-card accounting

Version 2 tracks a payment category per card. Fund spending categories normally:
funded credit purchases automatically reserve cash for payment, while unfunded
purchases become debt. Assign directly to payment categories for opening debt
and additional repayments. Payments remain real account transfers, including
split payments and reciprocal transactions with different posting dates.

Positive card balances behave like cash; only newly borrowed purchase amounts
need reserves. Refunds return money to their spending categories, including
prior-month refunds. Statement credits reduce debt without creating cash until
the balance becomes positive. Cash advances increase assignable cash without
funding repayment. Card-to-card balance transfers do not move payment reserves
automatically: move the category allocations yourself. YNAB's built-in interest
category is preserved as debt-only activity; ordinary Interest & Fees categories
can still fund purchases normally.

Cash spending has priority. Remaining category funds cover credit purchases in
stable date, sort-order, and transaction-ID order. Every month checks that
unassigned money, held funds, envelopes, and the credit-overspending correction
equal actual cash balances, including positive card balances. Edits, deletion,
rebudgeting, undo/redo, cache resets, and sync recompute history. Desktop and
mobile distinguish cash overspending, credit overspending, payment shortfalls,
uncovered debt, and excess reserves.

Payment amounts appear in the normal **Credit Card Payments** budget rows.
Click or tap a balance for its funding breakdown and the existing money-movement
actions. Status icons distinguish underfunding, overspending, and excess reserves
without adding a separate summary above the budget. On mobile, details open in
the standard balance bottom sheet. Negative-balance rollover is unavailable in
card mode because it conflicts with the native accounting rules.

#### Importing YNAB

Use the existing **nYNAB JSON import** with **Use YNAB-style credit-card payment
categories** selected. No CSV converter is needed. The JSON supplies account
types and closed-account flags. The importer preserves payment categories,
their historical allocations, hidden categories, transfers, and split data.
Official API nested transaction arrays and older flattened exports are accepted.

Before completion, the import compares account/cleared balances, category
allocations, activity, available amounts, and Ready to Assign to YNAB. A mismatch
discards the trial; it never invents balancing transactions or uploads a partial
budget. Successful native imports remain local and blocked from background sync
until you explicitly upload the reviewed budget. Exported amounts must be
exactly representable in Actual minor units, and payment-category names must
identify their card accounts uniquely.

This is not a blanket claim of identical YNAB behavior. YNAB does not document
every multi-card funding tie-break, and Actual retains its month-specific
allocation/holding semantics. The reconciliation gate rejects differing source
figures instead of silently claiming parity. Review an isolated import and use a
fresh JSON export before cutover. Link SimpleFIN to the reconciled existing
accounts afterward; bank credentials and server egress are separate setup.

#### New budgets and compatibility

In **Settings > General > Budget**, enable native payment categories in a new
envelope budget with only starting balances. To add another card later, create
its account with a starting balance, add its payment category in Settings, then
link bank sync. Existing version-1 demo budgets keep their original calculator;
they are not silently upgraded or reinterpreted.

Every browser, offline device, and API client must use this fork. Stock clients
ignore the accounting metadata; older version-1 fork clients reject version 2.
There is no flag-only conversion back to ordinary Actual. Preserve a complete
backup before changing accounting versions. Ordinary budgets and unselected
YNAB imports retain the upstream path.

The code is isolated in `credit-card-month.ts`, `credit-card-budget.ts`,
`ynab-credit-cards.ts`, and their types/UI. The original demo calculator is kept
in `credit-card-month-v1.ts`. Upgrades require accounting, migration, sync, and
browser tests; a clean patch application alone is not an upgrade certification.

Behavior references: YNAB's guides to
[credit overspending](https://support.ynab.com/en_us/credit-card-overspending-an-overview-HkMGpSbJs),
[refunds](https://support.ynab.com/en_us/credit-card-refunds-and-returns-H1J7qDWkj),
[statement credits](https://support.ynab.com/en_us/credit-card-rewards-and-statement-credits-a-guide-ryoRzYY0q),
[positive balances](https://support.ynab.com/en_us/credit-cards-with-a-positive-balance-an-overview-By_H6uzJo),
[cash advances](https://support.ynab.com/en_us/credit-card-cash-advances-an-overview-Hy6PmlOC9),
[balance transfers](https://support.ynab.com/en_us/how-to-make-a-credit-card-balance-transfer-ry5ETLWJo),
and [built-in interest](https://support.ynab.com/en_us/credit-card-interest-S1ovly_sMg).

Actual is a local-first personal finance tool. It is 100% free and open-source, written in NodeJS, it has a synchronization element so that all your changes can move between devices without any heavy lifting.

If you are interested in contributing, or want to know how development works, see our [contributing](https://actualbudget.org/docs/contributing/) document we would love to have you.

Want to say thanks? Click the ⭐ at the top of the page.

## Key Links

- Actual [discord](https://discord.gg/pRYNYr4W5A) community.
- Actual [Community Documentation](https://actualbudget.org/docs)
- [Frequently asked questions](https://actualbudget.org/docs/faq)

## Installation

There are four ways to deploy Actual:

1. One-click deployment [via PikaPods](https://www.pikapods.com/pods?run=actual) (~2.00 $/month) - recommended for non-technical users
1. Managed hosting [via Fly.io](https://actualbudget.org/docs/install/fly) (~1.50 $/month)
1. Self-hosted by using [a Docker image](https://actualbudget.org/docs/install/docker)
1. Local-only apps - [downloadable Windows, Mac and Linux apps](https://actualbudget.org/download/) you can run on your device

Learn more in the [installation instructions docs](https://actualbudget.org/docs/install/).

## Ready to Start Budgeting?

Read about [Envelope budgeting](https://actualbudget.org/docs/getting-started/envelope-budgeting) to know more about the idea behind Actual Budget.

### Are you new to budgeting or want to start fresh?

Check out the community's [Starting Fresh](https://actualbudget.org/docs/getting-started/starting-fresh) guide so you can quickly get up and running!

### Are you migrating from other budgeting apps?

Check out the community's [Migration](https://actualbudget.org/docs/migration/) guide to start jumping on the Actual Budget train!

## Documentation

We have a wide range of documentation on how to use Actual, this is all available in our [Community Documentation](https://actualbudget.org/docs), this includes topics on Budgeting, Account Management, Tips & Tricks and some documentation for developers.

## Contributing

Actual is a community driven product. Learn more about [contributing to Actual](https://actualbudget.org/docs/contributing/).

### Code structure

The Actual app is split up into a few packages:

- loot-core - The core application that runs on any platform
- desktop-client - The desktop UI
- desktop-electron - The desktop app

More information on the project structure is available in our [community documentation](https://actualbudget.org/docs/contributing/project-details).

### Feature Requests

Current feature requests can be seen [here](https://github.com/actualbudget/actual/issues?q=is%3Aissue+label%3A%22needs+votes%22+sort%3Areactions-%2B1-desc).
Vote for your favorite requests by reacting :+1: to the top comment of the request.

To add new feature requests, open a new Issue of the "Feature Request" type.

### Translation

Make Actual Budget accessible to more people by helping with the [Internationalization](https://actualbudget.org/docs/contributing/i18n/) of Actual. We are using a crowd sourcing tool to manage the translations, see our [Weblate Project](https://hosted.weblate.org/projects/actualbudget/). Weblate proudly supports open-source software projects through their [Libre plan](https://weblate.org/en/hosting/#libre).

<a href="https://hosted.weblate.org/engage/actualbudget/">
<img src="https://hosted.weblate.org/widget/actualbudget/actual/287x66-grey.png" alt="Translation status" />
</a>

## Sponsors

Thanks to our wonderful sponsors who make Actual Budget possible!

<a href="https://www.netlify.com"><img src="https://www.netlify.com/v3/img/components/netlify-color-accent.svg" alt="Deploys by Netlify" /></a>
<a href="https://depot.dev"><img src="https://depot.dev/badges/built-with-depot.svg" alt="Built with Depot" /></a>
<a href="https://www.docker.com"><img src="https://www.docker.com/app/uploads/2023/05/symbol_blue-docker-logo.png" alt="Docker" height="48" /></a>
<a href="https://github.com"><img src="https://avatars.githubusercontent.com/u/9919?s=200&v=4" alt="GitHub" height="48" /></a>
<a href="https://www.anthropic.com"><img src="https://avatars.githubusercontent.com/u/76263028?s=200&v=4" alt="Anthropic" height="48" /></a>
