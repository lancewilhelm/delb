## What

<!-- Describe the outcome for readers, hosts, or maintainers. Link the issue it closes. -->

## How

<!-- Summarize the implementation and any important tradeoffs. -->

## Data and access

<!-- Describe effects on the schema, stored files, permissions, or a reader's personal data. Write "No data or access changes" when none apply. -->

- [ ] Schema changes add a new migration and do not edit an existing one.
- [ ] Every new or changed endpoint checks the session, the server role, and tag visibility (the `visible_books` view).
- [ ] Screenshots, fixtures, and logs contain only synthetic data, with no real library, account details, or API keys.

## Automated checks

<!-- List the exact commands that you ran. CI runs the full suite again. -->

## Manual verification

<!-- Describe what a person did to check the change by hand: the setup (synthetic demo, browser, device), the steps, and what happened. Name anything that you could not check, and say why. -->
