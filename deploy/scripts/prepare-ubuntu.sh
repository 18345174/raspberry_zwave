#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y \
  curl \
  ca-certificates \
  build-essential \
  python3 \
  python3-pip \
  pkg-config \
  git \
  rsync

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

node --version
npm --version
