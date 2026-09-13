#!/usr/bin/env bash
# Start the recording page using the existing local credentials and Circle login.
set -euo pipefail
DEMO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DEMO_DIR/record.mjs"
