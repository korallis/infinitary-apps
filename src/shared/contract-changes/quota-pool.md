# A quota row may be a proxy's pool

A quota row (`quotaProviderViewSchema`) may carry `pool`, how a CLI proxy's pooled logins of one kind stand (`quotaPoolViewSchema`): how many it pools, and how many are unread, spent, switched off or need signing in again there.
Its windows are then the pool's shared allowance.
A view from before reads the row's windows as it did and shows no pool line.
