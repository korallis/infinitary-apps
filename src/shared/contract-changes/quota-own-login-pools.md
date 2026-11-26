# A quota snapshot may carry pools of the person's own logins

A quota snapshot (`quotaSnapshotViewSchema`) may carry `pools`: one row per provider, Claude or ChatGPT, with two or more enabled logins signed in on that computer.
Each is a quota row with no `accountId`, whose windows are the share left across those logins and whose `pool` says how they stand.
`pool.source` says whose logins a pool folds, `accounts` for the person's own and `proxy` (or absent) for a CLI proxy's, and `pool.accounts` names the accounts an `accounts` pool folds.
The account rows in `providers` are unchanged, one per login.
A view from before reads the account rows as it did and shows no pooled row.
