#!/usr/bin/env python3
"""适配工作流专用：用仓库自身的 builder 函数离线重建 dsh-runtime.inputs.json
与 ubuntu-tools.inputs.json，使 APK 内嵌资产通过 prepare-standard-assets 的锁校验。

说明：这两份 .inputs.json 是生成物（gitignore），官方 APK 不携带。本脚本只重建
「元数据」，不重新下载/构建任何内容；archive_sha256 直接取源文件实测摘要。
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'app/src/main/assets'


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def main():
    # ---- dsh-runtime.inputs.json ----
    builder = load_module('dsh_runtime_builder', ROOT / 'tools/build-dsh-runtime.py')
    runtime = ASSETS / 'dsh-runtime.bin'
    if not runtime.is_file():
        raise SystemExit('缺少 dsh-runtime.bin，先放入 app/src/main/assets/')
    dsh_version = json.loads((ROOT / 'tools/dsh-runtime/package.json').read_text(encoding='utf-8'))[
        'dependencies']['@deepseek-ai/dsh']
    runtime_meta = {
        'version': dsh_version,
        'inputs': builder.recipe_inputs(),
        'archive_sha256': digest(runtime),
    }
    (runtime.with_suffix('.inputs.json')).write_text(
        json.dumps(runtime_meta, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('dsh-runtime.inputs.json: version=%s archive_sha256=%s' % (dsh_version, runtime_meta['archive_sha256']))

    # ---- ubuntu-tools.inputs.json ----
    tools_builder = load_module('ubuntu_tools_builder', ROOT / 'tools/prepare-ubuntu-tools.py')
    lock = json.loads((ROOT / 'tools/ubuntu-tools/packages.lock.json').read_text(encoding='utf-8'))
    tools_bin = ASSETS / 'ubuntu-tools.bin'
    if not tools_bin.is_file():
        raise SystemExit('缺少 ubuntu-tools.bin，先放入 app/src/main/assets/')
    status_sha = None
    rootfs = ASSETS / 'offline-rootfs.bin'
    if rootfs.is_file():
        import tarfile
        with tarfile.open(rootfs, 'r:gz') as archive:
            for item in archive:
                name = item.name.removeprefix('./')
                if name == 'var/lib/dpkg/status':
                    status_sha = hashlib.sha256(archive.extractfile(item).read()).hexdigest()
                    break
    tools_meta = {
        'inputs': tools_builder.inputs(),
        'archive_sha256': digest(tools_bin),
        'installed_bytes': sum(int(r['Installed-Size']) * 1024 for r in lock['packages']),
        'base_status_sha256': lock['baseStatusSha256'],
        'packages': len(lock['packages']),
        'layout': 'configured-overlay-v1',
        'status_sha256': status_sha,
    }
    (tools_bin.with_suffix('.inputs.json')).write_text(
        json.dumps(tools_meta, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('ubuntu-tools.inputs.json: archive_sha256=%s status_sha256=%s (lock base=%s)' % (
        tools_meta['archive_sha256'], status_sha, lock['baseStatusSha256']))


if __name__ == '__main__':
    sys.exit(main())
