#!/usr/bin/env bash
set -euo pipefail

npm install --include=optional
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ensure-rollup-native.sh"
npm run build
