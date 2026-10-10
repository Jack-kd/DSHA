#!/usr/bin/env python3
"""从已发布的正式 APK 提取不在 git 中的离线构建输入。

git 里已提交 pnpm-runtime.bin / python-support.bin / glibc-python.tar.gz /
adb-wheels.tar.gz 以及全部文本资产；缺的是三个大文件：
  - offline-rootfs.bin（APK 里是优化后的减重版，sha256 与应急锁一致）
  - dsh-runtime.bin（APK 里与源端字节相同）
  - ubuntu-tools.bin（APK 里与源端字节相同）

本脚本从 APK assets/ 提取这三个文件，用项目自身的 recipe_inputs() /
inputs() 重新生成两个 inputs.json，再运行 prepare-runtime-descriptor.py
--write 更新描述符。应急归档由 Gradle 构建任务从生成的标准资产自动播种，
不需要手动放置。

构建时 prepare-standard-assets.py 会重新优化 rootfs：优化后的 rootfs 再跑
一次优化（移除 dsh 覆盖层条目 → 重新追加同一份覆盖层）产出相同字节，因此
最终 APK 中的 offline-rootfs.bin 与官方包一致。

用法：python3 tools/build-from-release.py <path-to-official.apk>
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import sys
import zipfile

# tools/ 下的脚本互相 import（如 from source_text import ...），需要把 tools/ 加入 sys.path
TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'app/src/main/assets'

# 需要从 APK 提取的文件（不在 git 里的大文件）。
EXTRACT_NAMES = ('offline-rootfs.bin', 'dsh-runtime.bin', 'ubuntu-tools.bin')


def sha256(path):
    value = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expected_sha256():
    """从项目自身的锁定文件读取期望的 sha256，不硬编码。

    offline-rootfs.bin 的 APK 版本是优化后的减重版，与应急锁里
    recovery-rootfs.bin 的 sha256 相同。dsh-runtime.bin 和 ubuntu-tools.bin
    在 APK 里与源端字节相同，从 runtime-descriptor.json 读取。
    """
    descriptor = json.loads((ASSETS / 'runtime-descriptor.json').read_text(encoding='utf-8'))
    recovery_lock = json.loads((ROOT / 'tools/recovery-runtime/lock.json').read_text(encoding='utf-8'))
    # 应急锁里 recovery-rootfs.bin 的 sha256 = 优化后 rootfs 的 sha256
    recovery_rootfs = next(row['sha256'] for row in recovery_lock['archives']
                          if row['asset'] == 'recovery-rootfs.bin')
    return {
        'offline-rootfs.bin': recovery_rootfs,
        'dsh-runtime.bin': descriptor['inputs']['dsh-runtime.bin'],
        'ubuntu-tools.bin': descriptor['inputs']['ubuntu-tools.bin'],
    }


def extract_assets(apk_path):
    """从 APK 的 assets/ 提取三个不在 git 里的大文件，校验 sha256。"""
    expected = expected_sha256()
    with zipfile.ZipFile(apk_path) as apk:
        available = {item.filename for item in apk.infolist()}
        for name in EXTRACT_NAMES:
            entry = 'assets/' + name
            if entry not in available:
                raise SystemExit(f'APK 里没有 {entry}；确认 APK 是 v0.2.0-rc2 正式包')
            target = ASSETS / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with apk.open(entry) as src, open(target, 'wb') as dst:
                for chunk in iter(lambda: src.read(1024 * 1024), b''):
                    dst.write(chunk)
            actual = sha256(target)
            if actual != expected[name]:
                raise SystemExit(f'{name} sha256 不匹配：{actual} != {expected[name]}')
            print(f'  提取 {name} ({actual})')


def regenerate_dsh_runtime_inputs():
    """用 build-dsh-runtime.py 的 recipe_inputs() 重新生成 dsh-runtime.inputs.json。"""
    builder = load_module('dsh_runtime_builder', ROOT / 'tools/build-dsh-runtime.py')
    lock_pkg = json.loads((ROOT / 'tools/dsh-runtime/package.json').read_text(encoding='utf-8'))
    version = lock_pkg['dependencies']['@deepseek-ai/dsh']
    runtime = ASSETS / 'dsh-runtime.bin'
    metadata = {
        'version': version,
        'inputs': builder.recipe_inputs(),
        'archive_sha256': sha256(runtime),
    }
    target = runtime.with_suffix('.inputs.json')
    target.write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(f'  生成 {target.name}（version={version}）')


def regenerate_ubuntu_tools_inputs():
    """用 prepare-ubuntu-tools.py 的 inputs() 重新生成 ubuntu-tools.inputs.json。"""
    builder = load_module('ubuntu_tools_builder', ROOT / 'tools/prepare-ubuntu-tools.py')
    lock = json.loads((ROOT / 'tools/ubuntu-tools/packages.lock.json').read_text(encoding='utf-8'))
    archive = ASSETS / 'ubuntu-tools.bin'
    metadata = {
        'inputs': builder.inputs(),
        'archive_sha256': sha256(archive),
        'installed_bytes': sum(int(row['Installed-Size']) * 1024 for row in lock['packages']),
        'base_status_sha256': lock['baseStatusSha256'],
        'packages': len(lock['packages']),
    }
    target = archive.with_suffix('.inputs.json')
    target.write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(f'  生成 {target.name}（packages={metadata["packages"]}）')


def regenerate_runtime_descriptor():
    """更新 runtime-descriptor.json 以匹配提取出来的离线文件。"""
    import subprocess
    script = ROOT / 'tools/prepare-runtime-descriptor.py'
    subprocess.check_call([sys.executable, '-B', str(script), '--write'])
    print('  更新 runtime-descriptor.json')


def main():
    if len(sys.argv) < 2:
        raise SystemExit('用法：python3 tools/build-from-release.py <official.apk>')
    apk = Path(sys.argv[1]).resolve()
    if not apk.is_file():
        raise SystemExit(f'找不到 APK：{apk}')

    print('==> 从 APK 提取离线构建输入')
    extract_assets(apk)

    print('==> 重新生成 dsh-runtime.inputs.json')
    regenerate_dsh_runtime_inputs()

    print('==> 重新生成 ubuntu-tools.inputs.json')
    regenerate_ubuntu_tools_inputs()

    print('==> 更新 runtime-descriptor.json')
    regenerate_runtime_descriptor()

    print('完成：离线输入就绪，可以运行 ./gradlew :app:assembleStandardRelease :app:assembleLowRelease -Pdsha.unsignedPackage=true')


if __name__ == '__main__':
    main()
