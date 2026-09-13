#!/usr/bin/env bash
# Start the GCP-backed recording page. Trigger the CLI agent through /demo/run
# as printed by the launcher; its six stages are streamed into the page.
set -euo pipefail
exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/record.sh" "$@"
