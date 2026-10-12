#!/usr/bin/env bash
# ============================================================================
# DSHA v0.2.0-rc2 适配构建脚本（Android 手机上的 Linux 容器专用）
#
# 背景：Jack-kd/DSHA 的 main 与 DSH-APP/DSHA 的 v0.2.0-rc2 标签源码逐字节一致，
# 但构建所需的离线资产（offline-rootfs.bin 源 rootfs、dsh-runtime.bin、
# ubuntu-tools.bin 等）不提交仓库，原 CI 从开发者私有的 asset bundle 恢复。
# 本脚本用「官方发布 APK 内嵌的资产」替代该 bundle：
#   - dsh-runtime.bin / ubuntu-tools.bin / pnpm-runtime.bin 等与受管描述符哈希一致，直接提取；
#   - offline-rootfs.bin 用 APK 内的「优化版 rootfs」作为构建源（prepare-standard-assets
#     会确定性重打包，产物即官方同款优化 rootfs，dpkg status 哈希与锁一致）；
#   - 重建 dsh-runtime.inputs.json / ubuntu-tools.inputs.json 元数据与 runtime-descriptor.json。
# 签名：历史发布证书（E7E3）不在本环境，构建走未签名 CI 模式，再用本地生成的
# keystore 签名（v1/v2/v3），产物与官方版本/内容一致但证书不同，不能覆盖安装官方包。
#
# 环境要求（脚本可自动安装一部分）：
#   - JDK 17（apt: openjdk-17-jdk-headless）
#   - python3
#   - Android SDK：platforms;android-37.0 + build-tools;36.0.0（arm64 手机无需 NDK：
#     native .so 全部仓库内预编译）
#   - qemu-user + amd64 libc6/libgcc-s1/libstdc++6（aapt2/zipalign/aidl 是 x86_64 二进制）
#   - 官方 APK 一份：dsha-0.2.0-rc2.apk（默认从 GitHub Releases 下载）
#
# 用法：
#   bash tools/build-adapted-020rc2.sh                 # 全流程：构建 + 签名 + 验证
#   bash tools/build-adapted-020rc2.sh --build-only    # 只构建未签名 APK
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD_ONLY="${1:-}"
OFFICIAL_APK_URL="https://github.com/DSH-APP/DSHA/releases/download/v0.2.0-rc2/dsha-0.2.0-rc2.apk"
OFFICIAL_APK="$ROOT/../refs/dsha-0.2.0-rc2.apk"
WORK="$ROOT/../.adapted-build-work"
ASSETS="$ROOT/app/src/main/assets"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/toolchains/android-sdk}}"
QEMU_ROOT="/opt/qemu-x86_64-root"
WRAP_AAPT2="${AAPT2_OVERRIDE:-/opt/toolchains/wrappers/aapt2}"

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-arm64}"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
export LANG="${LANG:-C.utf8}" LC_ALL="${LC_ALL:-C.utf8}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/opt/toolchains/gradle-user-home}"
export DSHA_PYTHON="${DSHA_PYTHON:-python3}"

say() { printf '\n\033[1;36m[adapted-build]\033[0m %s\n' "$*"; }

# ---------- 1. 版本核对 ----------
say "核对仓库版本 = v0.2.0-rc2 (build170)"
VERSION_NAME="$(grep -o 'versionName "[^"]*"' app/build.gradle | head -1)"
VERSION_CODE="$(grep -o 'versionCode [0-9]*' app/build.gradle | head -1)"
APK_NAME="$(grep -o "dshaApkNameVersion = '[^']*'" app/build.gradle)"
echo "   $APK_NAME | $VERSION_NAME | $VERSION_CODE"
[ "$(grep -o "dshaApkNameVersion = '[^']*'" app/build.gradle | grep -o "0.2.0-rc2")" = "0.2.0-rc2" ] \
  || { echo "仓库不是 v0.2.0-rc2，脚本仅适配该版本"; exit 1; }

# ---------- 2. 离线资产恢复（从官方 APK 提取） ----------
if [ ! -f "$ASSETS/offline-rootfs.bin" ] || [ ! -f "$ASSETS/dsh-runtime.bin" ]; then
  say "从官方 APK 提取离线资产"
  mkdir -p "$WORK/apk"
  if [ ! -f "$OFFICIAL_APK" ]; then
    echo "下载官方 APK（首次，约 273MB）..."
    python3 - "$OFFICIAL_APK_URL" "$OFFICIAL_APK" <<'PY'
import sys, urllib.request
urllib.request.urlretrieve(sys.argv[1], sys.argv[2])
print("下载完成", sys.argv[2])
PY
  fi
  unzip -q -o "$OFFICIAL_APK" \
    "assets/offline-rootfs.bin" "assets/dsh-runtime.bin" \
    "assets/ubuntu-tools.bin" "assets/ubuntu-tools.layout" "assets/ubuntu-tools.manifest.json" \
    "assets/pnpm-runtime.bin" "assets/python-support.bin" \
    -d "$WORK/apk"
  # 注意：offline-rootfs.bytes/.sha256/.layout、dsh-runtime.sha256 是构建生成物，
  # 不能放入源目录（asset-deployment.json 会拒绝未注册源文件）。
  for f in offline-rootfs.bin dsh-runtime.bin \
           ubuntu-tools.bin ubuntu-tools.layout ubuntu-tools.manifest.json \
           pnpm-runtime.bin python-support.bin; do
    cp "$WORK/apk/assets/$f" "$ASSETS/$f"
  done
  echo "资产已放入 app/src/main/assets/"
else
  say "离线资产已存在，跳过恢复"
fi

# ---------- 3. 重建元数据与描述符 ----------
say "重建 dsh-runtime.inputs.json / ubuntu-tools.inputs.json"
python3 -B tools/regenerate-input-metadata.py
say "重建 runtime-descriptor.json"
python3 -B tools/prepare-runtime-descriptor.py --write
python3 -B tools/prepare-runtime-descriptor.py --check && echo "描述符 OK"

# ---------- 4. 构建前 Python 预检 ----------
say "预检（runtime-tools / builtin / credential / backup-assets）"
python3 -B tools/prepare-runtime-tools.py --check
python3 -B tools/generate-builtin-plugins.py --verify
python3 -B tools/generate-credential-paths.py --check
python3 -B tools/prepare-backup-assets.py --check

# ---------- 5. 构建未签名 standard release ----------
say "构建 :app:assembleStandardRelease（未签名 CI 模式）"
bash gradlew :app:assembleStandardRelease \
  -Pdsha.unsignedPackage=true \
  -Pandroid.aapt2FromMavenOverride="$WRAP_AAPT2" \
  --console=plain

APK_OUT="$(ls app/build/outputs/apk/standard/release/*-unsigned.apk 2>/dev/null | head -1)"
[ -n "$APK_OUT" ] || { echo "未找到未签名 APK 产物"; exit 1; }
say "未签名产物: $APK_OUT"

[ "$BUILD_ONLY" = "--build-only" ] && { echo "构建完成（未签名）"; exit 0; }

# ---------- 6. 本地签名（v1/v2/v3，证书不同于官方 E7E3） ----------
say "生成本地 keystore 并签名（v1/v2/v3）"
mkdir -p "$WORK"
KS="$WORK/dsha-adapted.keystore"
if [ ! -f "$KS" ]; then
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -storepass dsha-adapted -keypass dsha-adapted \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 36500 \
    -dname "CN=DSHA Adapted Build, OU=DSHA, O=DSHA, L=CN, C=CN"
fi
SIGNED="$ROOT/../dsha-0.2.0-rc2-adapted.apk"
"$SDK/build-tools/36.0.0/apksigner" sign --ks "$KS" --ks-pass pass:dsha-adapted \
  --ks-key-alias androiddebugkey --key-pass pass:dsha-adapted \
  --out "$SIGNED" "$APK_OUT"
echo "已签名: $SIGNED"

# ---------- 7. 验证 ----------
say "验证签名与包信息"
"$SDK/build-tools/36.0.0/apksigner" verify --print-certs "$SIGNED" | head -6
"$WRAP_AAPT2" dump badging "$SIGNED" 2>/dev/null | grep -E "package:|versionName|sdkVersion" | head -4
echo "官方 APK 版本: 0.2.21-20261009.0750-dsh0.2.0-rc.2 / versionCode 170（预期一致）"
