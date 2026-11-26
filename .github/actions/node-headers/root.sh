#!/usr/bin/env bash
# Prints the folder whose include/node holds the running Node's headers.
#
# setup-node's archive (including the shell PC's preinstalled copy) has
# matching headers. An image that omits them fails here: a build that reads
# them must not fall back to node-gyp's network download.
set -euo pipefail

node_root="$(node -p 'require("node:path").dirname(require("node:path").dirname(require("node:fs").realpathSync(process.execPath)))')"
for header in node.h common.gypi config.gypi; do
  if [[ ! -f "$node_root/include/node/$header" ]]; then
    echo "Node's headers are not beside it: $node_root/include/node/$header is missing." >&2
    exit 1
  fi
done
printf '%s\n' "$node_root"
