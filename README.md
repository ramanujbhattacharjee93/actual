<p align="center">
  <img src="/demo.png" alt="Actualbudget" />
</p>

## Getting Started

### This fork: experimental credit-card payment categories

This fork adds an opt-in accounting mode, not just a payment preview. In
**Settings > General > Budget**, select card accounts in a new disposable
envelope budget and enable credit-card payment categories. Accounts may have
starting balances, but existing spending or allocations prevent enablement.
Fund spending categories normally; assign directly to the new payment
categories only for opening debt or additional debt repayment. Payments remain
ordinary account transfers. Desktop and mobile show reserves, uncovered debt,
payment overspending, and excess reserves.

The mode recalculates monthly history after edits and sync. Funded card purchases
move cash into payment reserves without allocating it twice. Only cash
overspending reduces next month's available funds; unfunded credit spending
remains debt. Refunds reverse payment reserves, including refunds in a later
month. Statement credits reduce debt without creating income.
Every calculated month checks that unassigned money, held funds, envelopes, and
the credit-overspending correction equal the actual cash-account balances.

**Demo use only, not ready for real finances or YNAB migration.** Positive card
balances, cash advances, card-to-card transfers, split or mismatched payment
pairs, carryover overrides, and multiple cards sharing an underfunded category
block the affected month and later months. Fix the source data in the account
register or use the blocked-category allocation editor; no calculated payment amounts
are returned while blocked. The original read-only preview remains available
only for ordinary envelope budgets.

All clients, including API integrations and offline devices, must use this fork.
Stock Actual clients do not enforce this restriction and can show different
totals. Mappings cannot be changed through settings or the generic preference
API. There is no flag-only conversion back: restore a pre-enablement export or
backup. Use a separate test budget, and keep YNAB authoritative.

This is not a full YNAB parity claim: the existing Actual month-specific
allocation and holding semantics remain in place. YNAB import, future-assignment
parity, bank connections, and production conversion are separate work.

The changes are isolated in `credit-card-month.ts`, `credit-card-budget.ts`, and
the corresponding shared types and UI. Ordinary Actual budgets keep the upstream
calculation path. Upgrades must pass the accounting, existing-budget, sync, and
browser tests; a clean patch application alone is not an upgrade certification.

Behavior references: YNAB's guides to
[credit overspending](https://support.ynab.com/en_us/credit-card-overspending-an-overview-HkMGpSbJs),
[refunds](https://support.ynab.com/en_us/credit-card-refunds-and-returns-H1J7qDWkj),
and [statement credits](https://support.ynab.com/en_us/credit-card-rewards-and-statement-credits-a-guide-ryoRzYY0q).

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
