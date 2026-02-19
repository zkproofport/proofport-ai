#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "=== proofport-ai Comprehensive Test Suite ==="
echo ""

# Phase 1: Unit + E2E tests (no external dependencies)
echo "Phase 1: Unit + E2E Tests"
echo "─────────────────────────"
npx vitest run
echo ""

# Phase 2: LLM Integration Tests (requires GEMINI_API_KEY)
echo "Phase 2: LLM Integration Tests (Real Gemini API)"
echo "──────────────────────────────────────────────────"

# Load GEMINI_API_KEY from .env.development if not already set
if [ -z "$GEMINI_API_KEY" ] && [ -f .env.development ]; then
  export GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env.development | cut -d= -f2)
fi

if [ -z "$GEMINI_API_KEY" ]; then
  echo "⚠ GEMINI_API_KEY not found — skipping LLM integration tests"
  echo "  Set GEMINI_API_KEY in .env.development or environment to enable"
else
  echo "GEMINI_API_KEY found — running LLM integration tests..."
  npx vitest run tests/e2e/a2a-llm-inference.test.ts
fi

echo ""
echo "=== All Tests Complete ==="
