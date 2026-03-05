#!/usr/bin/env bash
# Ensures all generated protobuf TypeScript files have // @ts-nocheck
# Run automatically before tsc to prevent strict-mode failures in generated code.
set -euo pipefail

GENERATED_DIR="src/generated"
DIRECTIVE="// @ts-nocheck"

find "$GENERATED_DIR" -name '*.ts' -type f | while IFS= read -r f; do
  first_line=$(head -1 "$f")
  if [[ "$first_line" != "$DIRECTIVE" ]]; then
    tmp=$(mktemp)
    { echo "$DIRECTIVE"; cat "$f"; } > "$tmp" && mv "$tmp" "$f"
  fi
done
