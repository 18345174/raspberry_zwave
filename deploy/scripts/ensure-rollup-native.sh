#!/usr/bin/env bash
set -euo pipefail

PLATFORM=$(node -p "process.platform")
ARCH=$(node -p "process.arch")

detect_linux_libc() {
  if [[ "$PLATFORM" != "linux" ]]; then
    return 0
  fi

  if ldd --version 2>&1 | grep -qi musl; then
    printf '%s\n' 'musl'
  else
    printf '%s\n' 'gnu'
  fi
}

LINUX_LIBC=$(detect_linux_libc)

native_package_for_rollup() {
  case "$PLATFORM" in
    linux)
      case "$ARCH" in
        arm64) printf '@rollup/rollup-linux-arm64-%s\n' "$LINUX_LIBC" ;;
        arm)
          if [[ "$LINUX_LIBC" == "musl" ]]; then
            printf '%s\n' '@rollup/rollup-linux-arm-musleabihf'
          else
            printf '%s\n' '@rollup/rollup-linux-arm-gnueabihf'
          fi
          ;;
        x64) printf '@rollup/rollup-linux-x64-%s\n' "$LINUX_LIBC" ;;
        *) return 1 ;;
      esac
      ;;
    darwin)
      case "$ARCH" in
        arm64) printf '%s\n' '@rollup/rollup-darwin-arm64' ;;
        x64) printf '%s\n' '@rollup/rollup-darwin-x64' ;;
        *) return 1 ;;
      esac
      ;;
    win32)
      case "$ARCH" in
        arm64) printf '%s\n' '@rollup/rollup-win32-arm64-msvc' ;;
        ia32) printf '%s\n' '@rollup/rollup-win32-ia32-msvc' ;;
        x64) printf '%s\n' '@rollup/rollup-win32-x64-msvc' ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

native_package_for_esbuild() {
  case "$PLATFORM" in
    linux)
      case "$ARCH" in
        arm64) printf '%s\n' '@esbuild/linux-arm64' ;;
        arm) printf '%s\n' '@esbuild/linux-arm' ;;
        x64) printf '%s\n' '@esbuild/linux-x64' ;;
        ia32) printf '%s\n' '@esbuild/linux-ia32' ;;
        riscv64) printf '%s\n' '@esbuild/linux-riscv64' ;;
        ppc64) printf '%s\n' '@esbuild/linux-ppc64' ;;
        s390x) printf '%s\n' '@esbuild/linux-s390x' ;;
        loong64) printf '%s\n' '@esbuild/linux-loong64' ;;
        *) return 1 ;;
      esac
      ;;
    darwin)
      case "$ARCH" in
        arm64) printf '%s\n' '@esbuild/darwin-arm64' ;;
        x64) printf '%s\n' '@esbuild/darwin-x64' ;;
        *) return 1 ;;
      esac
      ;;
    win32)
      case "$ARCH" in
        arm64) printf '%s\n' '@esbuild/win32-arm64' ;;
        ia32) printf '%s\n' '@esbuild/win32-ia32' ;;
        x64) printf '%s\n' '@esbuild/win32-x64' ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

ensure_native_dependency() {
  local package_name=$1
  local package_dir=$2
  local package_version=$3
  local install_root=$4
  local native_package=$5
  local native_path="$install_root/node_modules/$native_package"

  if [[ -d "$native_path" ]]; then
    echo "[native-deps] Found $native_package@$package_version for $package_name in $install_root"
    return 0
  fi

  echo "[native-deps] Missing $native_package@$package_version for $package_name in $install_root, installing explicitly..."
  npm install --prefix "$install_root" --no-save --include=optional "${native_package}@${package_version}"

  if [[ ! -d "$native_path" ]]; then
    echo "[native-deps] Failed to install $native_package@$package_version for $package_name in $install_root" >&2
    exit 1
  fi

  echo "[native-deps] Installed $native_package@$package_version for $package_name in $install_root"
}

ensure_rollup_native() {
  local package_json=$1
  local rollup_dir package_version install_root native_package prefixed_json

  rollup_dir=$(dirname "$package_json")
  package_version=$(node -p "require('./${package_json}').version")
  prefixed_json="./${package_json#./}"
  install_root=${prefixed_json%/node_modules/*/package.json}
  native_package=$(native_package_for_rollup || true)

  if [[ -z "${native_package:-}" ]]; then
    echo "[native-deps] No rollup native package mapping for $PLATFORM/$ARCH, skipping $rollup_dir"
    return 0
  fi

  ensure_native_dependency "rollup" "$rollup_dir" "$package_version" "$install_root" "$native_package"
}

ensure_esbuild_native() {
  local package_json=$1
  local esbuild_dir package_version install_root native_package prefixed_json

  esbuild_dir=$(dirname "$package_json")
  package_version=$(node -p "require('./${package_json}').version")
  prefixed_json="./${package_json#./}"
  install_root=${prefixed_json%/node_modules/*/package.json}
  native_package=$(native_package_for_esbuild || true)

  if [[ -z "${native_package:-}" ]]; then
    echo "[native-deps] No esbuild native package mapping for $PLATFORM/$ARCH, skipping $esbuild_dir"
    return 0
  fi

  ensure_native_dependency "esbuild" "$esbuild_dir" "$package_version" "$install_root" "$native_package"
}

shopt -s nullglob

rollup_packages=(node_modules/rollup/package.json node_modules/*/node_modules/rollup/package.json)
esbuild_packages=(node_modules/esbuild/package.json node_modules/*/node_modules/esbuild/package.json)

if [[ ${#rollup_packages[@]} -eq 0 && ${#esbuild_packages[@]} -eq 0 ]]; then
  echo "[native-deps] No rollup/esbuild packages found yet, skipping."
  exit 0
fi

for package_json in "${rollup_packages[@]}"; do
  [[ -f "$package_json" ]] || continue
  ensure_rollup_native "$package_json"
done

for package_json in "${esbuild_packages[@]}"; do
  [[ -f "$package_json" ]] || continue
  ensure_esbuild_native "$package_json"
done
