Adds the reporting connection a person saves in Settings → Intelligence: `inf:settings:usage-connection:get`, `inf:settings:usage-connection:save` and `inf:settings:usage-connection:remove`.
Adds the optional `connection` field to `inf:usage:reporting`, the host of that connection.
An older side has no such requests, so its window shows no reporting connection row, and it leaves `connection` out, so the Usage view shows no line for it.
