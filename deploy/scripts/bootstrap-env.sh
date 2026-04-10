#!/usr/bin/env bash
set -euo pipefail

TARGET_FILE=${1:-backend/.env}

if [[ -f "$TARGET_FILE" ]]; then
  echo "$TARGET_FILE already exists"
  exit 0
fi

cp backend/.env.example "$TARGET_FILE"
echo "Created $TARGET_FILE"
echo "Tip: generate ADMIN_PASSWORD_HASH with: node backend/scripts/generate-password-hash.mjs '<your-password>'"
