# A quota row may be a proxy's pool

A quota row (`quotaProviderViewSchema`) may carry `pool`, how a CLI proxy's pooled logins of one kind stand (`quotaPoolViewSchema`): how many it pools, and how many are unread, spent, switched off or need signing in again there.
Its windows are then the pool's shared allowance, and `pool.models` names the models it measures when the row is one of a connection's pools.
A row read through a proxy, a pool or a proxy that did not answer, also carries `fromProxy`.
A view from before reads the row's windows as it did, shows no pool line and ignores both marks.
