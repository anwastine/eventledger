# Event Ledger

Track client events, payments received, expenses, and payments owed to workers/services — with a dashboard of money in and money out. Runs entirely in the browser, hosted on GitHub Pages; data is stored in a **private** GitHub repo so it follows you across devices.

## Setup
1. Open the app link. Choose a password.
2. Paste a GitHub fine-grained token that has **Contents: Read and write** on your private data repo (default `anwastine/eventledger-data`).
3. On another device, enter the same password + token once. After that, password only.

Leave the token blank to keep data on one device only (no sync).

## Money rules
- **Total billed** = closed cost
- **Need to collect** = billed − payments received
- **Total expense** = direct expenses + agreed vendor/worker amounts
- **Expected profit** = billed − total expense
- **Need to pay** = vendor amounts − vendor payments made
- **Cash position** = received − direct expenses − vendor payments made
