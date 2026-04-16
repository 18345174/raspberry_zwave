#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f "node_modules/rollup/package.json" ]]; then
  echo "[rollup-native] rollup is not installed yet, skipping native package check."
  exit 0
fi

detect_rollup_native_package() {
  local platform arch libc_suffix=""

  platform=$(node -p "process.platform")
  arch=$(node -p "process.arch")

  case "$platform" in
    linux)
      if ldd --version 2>&1 | grep -qi musl; then
        libc_suffix="musl"
      else
        libc_suffix="gnu"
      fi

      case "$arch" in
        arm64) printf '@rollup/rollup-linux-arm64-%s\n' "$libc_suffix" ;;
        arm) printf '@rollup/rollup-linux-arm-%s\n' "$([[ "$libc_suffix" == "musl" ]] && printf 'musleabihf' || printf 'gnueabihf')" ;;
        x64) printf '@rollup/rollup-linux-x64-%s\n' "$libc_suffix" ;;
        *) return 1 ;;
      esac
      ;;
    darwin)
      case "$arch" in
        arm64) printf '%s\n' '@rollup/rollup-darwin-arm64' ;;
        x64) printf '%s\n' '@rollup/rollup-darwin-x64' ;;
        *) return 1 ;;
      esac
      ;;
    win32)
      case "$arch" in
        arm64) printf '%s\n' '@rollup/rollup-win32-arm64-msvc' ;;
        ia32) printf '%s\n' '@rollup/rollup-win32-ia32-msvc' ;;
        x64) printf '%s\n' '@rollup/rollup-win32-x64-msvc' ;;
        *) return 1 ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac
}

ROLLUP_NATIVE_PACKAGE=$(detect_rollup_native_package || true)

if [[ -z "${ROLLUP_NATIVE_PACKAGE:-}" ]]; then
  echo "[rollup-native] No native rollup package mapping for this platform, skipping."
  exit 0
fi

ROLLUP_VERSION=$(node -p "require('./node_modules/rollup/package.json').version")
ROLLUP_NATIVE_PATH="node_modules/${ROLLUP_NATIVE_PACKAGE}"

if [[ -d "$ROLLUP_NATIVE_PATH" ]]; then
  echo "[rollup-native] Found $ROLLUP_NATIVE_PACKAGE@$ROLLUP_VERSION"
  exit 0
fi

echo "[rollup-native] Missing $ROLLUP_NATIVE_PACKAGE@$ROLLUP_VERSION, installing it explicitly..."
npm install --no-save --include=optional "${ROLLUP_NATIVE_PACKAGE}@${ROLLUP_VERSION}"

if [[ ! -d "$ROLLUP_NATIVE_PATH" ]]; then
  echo "[rollup-native] Failed to install $ROLLUP_NATIVE_PACKAGE@$ROLLUP_VERSION" >&2
  exit 1
fi

echo "[rollup-native] Installed $ROLLUP_NATIVE_PACKAGE@$ROLLUP_VERSION successfully."
