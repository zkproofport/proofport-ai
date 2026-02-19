#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "Stopping A2A test stack..."
docker compose -f docker-compose.yml -f docker-compose.test.yml down

echo "Done."
