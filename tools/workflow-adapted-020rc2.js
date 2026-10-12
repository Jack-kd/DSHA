// ============================================================================
// DSHA v0.2.0-rc2 适配构建 —— DSH workflow 编排脚本
// 在 DeepSeek Harness Web GUI 中通过 workflow 工具运行（本文件为 body）。
// 作用：把「从 Jack-kd/DSHA 编译出用户正在使用的 v0.2.0-rc2 版本」拆成
//   阶段0（并行验证）→ 阶段1（资产恢复+元数据重建）→ 阶段2（构建）→ 阶段3（签名+验证）。
// 依赖本仓库 tools/build-adapted-020rc2.sh（已固化全部实测命令）。
// 用法：workflow 工具 → 粘贴本文件内容（或经 workflow.run 引用）→ 等待完成。
// ============================================================================
const REPO = "/sdcard/DSHAPP/DSHA-main";           // 你的仓库路径（可改）
const OFFICIAL_APK = "/sdcard/DSHAPP/refs/dsha-0.2.0-rc2.apk"; // 官方 APK 路径
const SCRIPT = `${REPO}/tools/build-adapted-020rc2.sh`;

const okSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    detail: { type: "string" },
  },
  required: ["ok", "detail"],
  additionalProperties: false,
};

phase("阶段0：并行验证源码与资产指纹");
log("两个 subagent 并行核对：① 仓库是否 v0.2.0-rc2；② 离线资产与描述符哈希是否一致。");

const [vSource, vAssets] = await parallel([
  () =>
    agent(
      `你只做一件事：验证 Android 仓库 ${REPO} 的版本身份。\n` +
        `运行：grep -E "dshaApkNameVersion|versionName|versionCode" ${REPO}/app/build.gradle | head -5\n` +
        `并用 python3 检查 ${REPO}/app/src/main/assets/runtime-descriptor.json 存在且 dshVersion=="0.2.0-rc.2"。\n` +
        `返回 {ok: 布尔, detail: 提取到的 dshaApkNameVersion/versionName/versionCode}。`,
      { label: "版本核对", schema: okSchema }
    ),
  () =>
    agent(
      `你只做一件事：核对离线资产指纹。仓库 ${REPO}/app/src/main/assets 下应有 ` +
        `offline-rootfs.bin、dsh-runtime.bin、ubuntu-tools.bin、pnpm-runtime.bin。\n` +
        `运行 python3 脚本：读 runtime-descriptor.json 的 inputs 字段，对 offline-rootfs.bin、dsh-runtime.bin、` +
        `ubuntu-tools.bin、pnpm-runtime.bin 计算 sha256 并与 inputs 中同名条目比较（允许 offline-rootfs.bin 与描述符不同，` +
        `因为本适配用 APK 内优化 rootfs 当源）。\n` +
        `返回 {ok: dsh-runtime/ubuntu-tools/pnpm-runtime 全部匹配, detail: 每个文件的匹配情况}。`,
      { label: "资产指纹核对", schema: okSchema }
    ),
]);

log(`版本核对: ${vSource && vSource.ok ? "OK" : "FAIL"} | ${vSource ? vSource.detail : "agent 失败"}`);
log(`资产指纹: ${vAssets && vAssets.ok ? "OK" : "FAIL"} | ${vAssets ? vAssets.detail : "agent 失败"}`);
if (!vSource || !vSource.ok) return { status: "blocked", reason: "仓库版本身份核对失败" };

phase("阶段1：恢复离线资产并重建元数据/描述符");
log("若资产缺失则从官方 APK 提取；随后重建 dsh-runtime.inputs.json、ubuntu-tools.inputs.json 与 runtime-descriptor.json。");
const prep = await agent(
  `在 ${REPO} 仓库目录里执行适配准备（命令都以 bash 运行，路径已绝对化）：\n` +
    `1) bash -n ${SCRIPT} 确认语法；\n` +
    `2) python3 -B ${REPO}/tools/regenerate-input-metadata.py\n` +
    `3) cd ${REPO}/tools && python3 -B prepare-runtime-descriptor.py --write && python3 -B prepare-runtime-descriptor.py --check\n` +
    `4) python3 -B ${REPO}/tools/prepare-runtime-tools.py --check && python3 -B ${REPO}/tools/generate-builtin-plugins.py --verify && ` +
    `python3 -B ${REPO}/tools/generate-credential-paths.py --check && python3 -B ${REPO}/tools/prepare-backup-assets.py --check\n` +
    `任一命令失败立即返回失败。返回 {ok, detail: 每步的摘要输出}。`,
  { label: "资产与元数据准备", schema: okSchema }
);
if (!prep || !prep.ok) return { status: "failed", phase: 1, detail: prep ? prep.detail : "准备失败" };

phase("阶段2：构建未签名 standard release");
log("运行 gradlew :app:assembleStandardRelease（-Pdsha.unsignedPackage=true，aapt2 走 qemu wrapper）。这一步耗时最长（首次含依赖下载）。");
const build = await agent(
  `执行 Android 构建（在你自己的 bash 环境，环境变量请自行设置）：\n` +
    `cd ${REPO}\n` +
    `export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-arm64 ANDROID_HOME=/opt/toolchains/android-sdk ANDROID_SDK_ROOT=/opt/toolchains/android-sdk\n` +
    `export LANG=C.utf8 LC_ALL=C.utf8 GRADLE_USER_HOME=/opt/toolchains/gradle-user-home DSHA_PYTHON=python3\n` +
    `bash gradlew :app:assembleStandardRelease -Pdsha.unsignedPackage=true -Pandroid.aapt2FromMavenOverride=/opt/toolchains/wrappers/aapt2 --console=plain\n` +
    `随后确认存在：ls ${REPO}/app/build/outputs/apk/standard/release/*-unsigned.apk\n` +
    `如果 gradlew 报 Permission denied，先 chmod +x ${REPO}/gradlew 再重跑。` +
    `返回 {ok, detail: BUILD SUCCESSFUL 行与产物路径}。`,
  { label: "Gradle 构建", schema: okSchema, run_in_background: false }
);
if (!build || !build.ok) return { status: "failed", phase: 2, detail: build ? build.detail : "构建失败" };

phase("阶段3：签名 + 验证");
log("用本地生成的 keystore 签 v1/v2/v3，并核对版本号与官方一致。");
const sign = await agent(
  `签名并验证（在 ${REPO} 仓库）:\n` +
    `bash ${SCRIPT}\n` +
    `即：生成本地 keystore（不存在时）、apksigner 签未签名 APK 为 /sdcard/DSHAPP/dsha-0.2.0-rc2-adapted.apk，` +
    `随后 apksigner verify --print-certs 与 aapt2 dump badging 输出。\n` +
    `返回 {ok, detail: 证书 SHA-256 与 versionName/versionCode}。`,
  { label: "签名与验证", schema: okSchema }
);

return {
  status: sign && sign.ok ? "success" : "failed",
  source: "Jack-kd/DSHA @ main == DSH-APP/DSHA v0.2.0-rc2",
  phase0: { source: vSource && vSource.detail, assets: vAssets && vAssets.detail },
  phase1: prep && prep.detail,
  phase2: build && build.detail,
  phase3: sign && sign.detail,
  artifacts: ["/sdcard/DSHAPP/dsha-0.2.0-rc2-adapted.apk"],
  note: "签名证书为本地产（非官方 E7E3），与官方 APK 同版本内容，但覆盖安装官方包前需先卸载官方版本。",
};
