# 适配工作流：从 Jack-kd/DSHA 编译出 v0.2.0-rc2（build170）

> 目标：把你正在使用的官方版本 `dsha-0.2.0-rc2.apk`
> （com.dsh.client / versionCode 170 / versionName 0.2.21-20261009.0750-dsh0.2.0-rc.2）
> 从**你的仓库**重新编译出来。
>
> 前提事实：`Jack-kd/DSHA` 的 main 与 `DSH-APP/DSHA` 的 `v0.2.0-rc2` 标签源码
> 逐字节一致（仅 star-history 自动生成图不同），因此在本仓库构建 = 编译官方同版本。

## 为什么需要“适配”

DSHA 的构建依赖一批**离线固定输入**（源码不提交、由原 CI 从开发者私有的 asset bundle
恢复）：`offline-rootfs.bin`（Ubuntu 源 rootfs，SHA-256 `0a680b56…`）、
`dsh-runtime.bin`、`ubuntu-tools.bin`、`pnpm-runtime.bin` 等。普通 clone 无法构建。

本工作流的适配点（全部实测通过）：

1. **资产来源改用官方发布 APK**：官方 `dsha-0.2.0-rc2.apk` 内嵌全部离线资产，
   `dsh-runtime.bin` / `ubuntu-tools.bin` / `pnpm-runtime.bin` 与受管描述符哈希一致，直接提取。
2. **offline-rootfs.bin 用 APK 内的“优化版 rootfs”当源**：`prepare-standard-assets.py`
   会确定性重打包，产物即官方同款优化 rootfs（`b9fe8a04…`）；其 `var/lib/dpkg/status`
   哈希与 `tools/ubuntu-tools/packages.lock.json` 锁定值一致（`922b9fd7…`）。
3. **重建生成元数据**：`dsh-runtime.inputs.json`、`ubuntu-tools.inputs.json` 是
   gitignore 的生成物，官方 APK 不携带；用 `tools/regenerate-input-metadata.py`
   （复用仓库自身 builder 函数，纯离线）重建，使资产通过锁校验。
4. **重建 runtime-descriptor.json**：源 rootfs 哈希与官方不同
   （官方是未提交的源 rootfs，本工作流用优化 rootfs），
   `prepare-runtime-descriptor.py --write` 重算 runtimeId（仅内部记账，运行不受影响）。
5. **arm64 手机工具链**：aapt2 / zipalign / aidl 是 x86_64 二进制，用
   `qemu-user` + amd64 libc 包装运行；JDK 17 / python3 由 apt 安装；
   standard 构建**不需要 NDK**（native .so 全部仓库内预编译提交）。
6. **签名**：历史发布证书（E7E3）不在本环境，构建走未签名 CI 模式
   （`-Pdsha.unsignedPackage=true`），再用本地生成的 keystore 签 v1/v2/v3。

## 一键运行

```bash
bash tools/build-adapted-020rc2.sh          # 全流程：恢复资产→重建元数据→构建→签名→验证
bash tools/build-adapted-020rc2.sh --build-only   # 只构建未签名 APK
```

产物：`/sdcard/DSHAPP/dsha-0.2.0-rc2-adapted.apk`（已签名、可安装）。

DSH workflow 编排版本见 `tools/workflow-adapted-020rc2.js`（在 Web GUI 的
workflow 工具里运行，分 4 个阶段并行/串行编排，结果结构化返回）。

## 产物与官方 APK 的一致性

| 项目 | 结果 |
|---|---|
| 包名 / versionCode / versionName / minSdk / targetSdk | 完全一致（com.dsh.client / 170 / 0.2.21-…rc.2 / 30 / 37） |
| APK 条目（1248 项对比） | **1237 项字节级一致**（全部 dex、资源、离线 rootfs、dsh-runtime、插件、网页） |
| 差异 1：6 个 proroot 系 .so | 官方为 NDK llvm-strip 剥离版，本产物为仓库原版（功能相同，稍大） |
| 差异 2：assets/runtime-descriptor.json | runtimeId 不同（源 rootfs 身份记账，见上） |
| 差异 3：META-INF 签名 | 证书不同（本产物为本地产，非官方 E7E3） |
| debuggable | 均为 false（正式） |

> ⚠️ 因为签名证书不同，**覆盖安装官方版前需先卸载官方版**
> （Android 只允许同签名覆盖安装），或作为独立安装使用。

## 已知边界

- `low` 版（Gecko 内核）未构建；构建 `low` 需要 maven.mozilla.org（本环境不可达）与 NDK 重编。
- 6 个 .so 的字节级一致需 NDK 26.3 的 llvm-strip（x86_64 主机工具 + qemu），未追求。
- 官方源 rootfs（`0a680b56…`）为开发者私有固定输入，无法从公开渠道恢复；
  本工作流用等价优化 rootfs 自洽构建。

## 在 GitHub Actions 里构建（推荐）

仓库里已加入 [`.github/workflows/rebuild-v0.2.0-rc2.yml`](../.github/workflows/rebuild-v0.2.0-rc2.yml)：

1. 打开 **Actions** → 左侧 **Build v0.2.0-rc2 (adapted)** → **Run workflow**；
2. 工作流自动：下载官方 APK → 提取离线输入 → 重建元数据/描述符 → 契约检查 →
   `assembleStandardRelease` → 用（缓存的）本地密钥签名 → 与官方 APK 逐条目对比 →
   上传 `dsha-0.2.0-rc2-adapted` 产物（含 SHA256SUMS.txt）。

要点：

- **不需要任何私有资产包或官方签名密钥**；若不提供 `DSHA_KEYSTORE_BASE64` 等 secrets，
  工作流会自动生成一个密钥并用 Actions 缓存固定下来，后续构建签名一致、可互相覆盖安装。
- 想用你自己的固定密钥，添加仓库 secrets：`DSHA_KEYSTORE_BASE64`（keystore 的 base64）、
  `DSHA_KEYSTORE_PASSWORD`、`DSHA_KEY_PASSWORD`、`DSHA_KEY_ALIAS`。
- 官方 APK 的 SHA-256 作为工作流输入固定（默认 `1fedf883…`），保证离线输入同源。
- Linux x86_64 runner 上 aapt2/zipalign/aidl 原生运行，**不需要**手机端那套 qemu 包装。

> 说明：原仓库的 `ci-package.yml` / `release.yml` 是「手动触发 + 外部资产包 + 官方密钥」的
> 正式发版链路，在 fork 里没有输入可跑，因此不会自动产出 APK；本工作流是给 fork 用的替代链路。
