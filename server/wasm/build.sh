#!/bin/sh
# Rebuilds web/public/fx.wasm from the firmware's effects. Needs clang with the wasm32 target and wasm-ld.
set -e
cd "$(dirname "$0")"
clang --target=wasm32 -nostdlib -O2 -fno-exceptions -fno-rtti -std=c++17 \
  -I shim -I ../../firmware/src \
  -Wl,--no-entry -Wl,--allow-undefined -Wl,--strip-all \
  -o ../web/public/fx.wasm fxwasm.cpp ../../firmware/src/effects.cpp
echo "built web/public/fx.wasm"
