#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="$ROOT_DIR/anchor-core"
EXT_DIR="$ROOT_DIR/anchor-extension"
UI_DIR="$ROOT_DIR/anchor-ui"
BIN_DIR="$EXT_DIR/bin"

mkdir -p "$BIN_DIR"

build_target() {
  local target="$1"
  local output_name="$2"
  local binary_name="anchor-core"
  if [[ "$target" == *"windows"* ]]; then
    binary_name="anchor-core.exe"
  fi

  echo "Building anchor-core for $target..."
  if cargo build --manifest-path "$CORE_DIR/Cargo.toml" --release --target "$target"; then
    local src="$CORE_DIR/target/$target/release/$binary_name"
    if [[ -f "$src" ]]; then
      cp "$src" "$BIN_DIR/$output_name"
      chmod +x "$BIN_DIR/$output_name" || true
      echo "Copied $output_name"
    else
      echo "Warning: expected binary not found at $src"
    fi
  else
    echo "Warning: failed to build target $target (continuing)"
  fi
}

build_target "x86_64-unknown-linux-gnu" "anchor-core-linux-x64"
build_target "x86_64-apple-darwin" "anchor-core-darwin-x64"
build_target "aarch64-apple-darwin" "anchor-core-darwin-arm64"
build_target "x86_64-pc-windows-msvc" "anchor-core-win32-x64.exe"

pushd "$EXT_DIR" >/dev/null
npm install
npm run compile
popd >/dev/null

pushd "$UI_DIR" >/dev/null
npm install
npm run build
popd >/dev/null

pushd "$EXT_DIR" >/dev/null
npx vsce package
popd >/dev/null

echo "Build pipeline complete."
