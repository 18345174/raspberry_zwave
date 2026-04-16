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

package_install_root() {
  local package_json=$1
  local prefixed_json="./${package_json#./}"
  printf '%s\n' "${prefixed_json%/node_modules/*/package.json}"
}

package_version() {
  local package_json=$1
  node -p "require('./${package_json#./}').version"
}

is_native_installed() {
  local install_root=$1
  local native_package=$2
  [[ -d "$install_root/node_modules/$native_package" ]]
}

QUEUE_ROOTS=()
QUEUE_SPECS=()

queue_install() {
  local install_root=$1
  local package_spec=$2
  local index

  for index in "${!QUEUE_ROOTS[@]}"; do
    if [[ "${QUEUE_ROOTS[$index]}" == "$install_root" ]]; then
      case " ${QUEUE_SPECS[$index]} " in
        *" ${package_spec} "*) return 0 ;;
      esac
      QUEUE_SPECS[$index]="${QUEUE_SPECS[$index]} ${package_spec}"
      return 0
    fi
  done

  QUEUE_ROOTS+=("$install_root")
  QUEUE_SPECS+=("$package_spec")
}

collect_missing_rollup_native() {
  local package_json=$1
  local version install_root native_package

  native_package=$(native_package_for_rollup || true)
  if [[ -z "${native_package:-}" ]]; then
    echo "[native-deps] No rollup native package mapping for $PLATFORM/$ARCH, skipping $package_json"
    return 0
  fi

  version=$(package_version "$package_json")
  install_root=$(package_install_root "$package_json")

  if is_native_installed "$install_root" "$native_package"; then
    echo "[native-deps] Found $native_package@$version for rollup in $install_root"
    return 0
  fi

  echo "[native-deps] Missing $native_package@$version for rollup in $install_root"
  queue_install "$install_root" "${native_package}@${version}"
}

collect_missing_esbuild_native() {
  local package_json=$1
  local version install_root native_package

  native_package=$(native_package_for_esbuild || true)
  if [[ -z "${native_package:-}" ]]; then
    echo "[native-deps] No esbuild native package mapping for $PLATFORM/$ARCH, skipping $package_json"
    return 0
  fi

  version=$(package_version "$package_json")
  install_root=$(package_install_root "$package_json")

  if is_native_installed "$install_root" "$native_package"; then
    echo "[native-deps] Found $native_package@$version for esbuild in $install_root"
    return 0
  fi

  echo "[native-deps] Missing $native_package@$version for esbuild in $install_root"
  queue_install "$install_root" "${native_package}@${version}"
}

install_queued_packages() {
  local index

  for index in "${!QUEUE_ROOTS[@]}"; do
    echo "[native-deps] Installing missing native packages in ${QUEUE_ROOTS[$index]}: ${QUEUE_SPECS[$index]}"
    npm install --prefix "${QUEUE_ROOTS[$index]}" --no-save --include=optional ${QUEUE_SPECS[$index]}
  done
}

reset_queue() {
  QUEUE_ROOTS=()
  QUEUE_SPECS=()
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
  collect_missing_rollup_native "$package_json"
done

for package_json in "${esbuild_packages[@]}"; do
  [[ -f "$package_json" ]] || continue
  collect_missing_esbuild_native "$package_json"
done

if [[ ${#QUEUE_ROOTS[@]} -eq 0 ]]; then
  exit 0
fi

install_queued_packages
reset_queue

for package_json in "${rollup_packages[@]}"; do
  [[ -f "$package_json" ]] || continue
  collect_missing_rollup_native "$package_json"
done

for package_json in "${esbuild_packages[@]}"; do
  [[ -f "$package_json" ]] || continue
  collect_missing_esbuild_native "$package_json"
done

if [[ ${#QUEUE_ROOTS[@]} -gt 0 ]]; then
  echo "[native-deps] Native dependency verification still reports missing packages after install." >&2
  exit 1
fi
