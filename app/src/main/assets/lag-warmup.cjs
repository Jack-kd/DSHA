'use strict';
/*
 * DSHA 启动预热：把「首次使用才触发的重活」提前到 Web 启动阶段消化掉。
 *
 * 背景（实测定位）：flock 的原生绑定是懒加载，第一次用时才执行
 * process.report.getReport() 判断 libc。在 proot 容器里这次调用会阻塞事件循环
 * 约 76 秒（采样器抓到 getReport 自耗时 76136.7ms）。它发生在「第一次写会话/拿文件锁」
 * 时 —— 也就是用户进入工作台、选工作区那一下，表现为「加载了好久」。
 *
 * B 方案（flock-libc-patch.json）已经用文件系统判据替换掉 getReport()，从根上消除这次
 * 阻塞。本模块是 A 方案的兜底：在 Web 启动时主动触发一次原生绑定加载与 libc 判定，
 * 这样即使还有残留的初始化开销，也发生在启动等待期，而不是用户交互时。
 *
 * 原则：只做预热、不改变任何行为；任何失败都不影响 dsh 启动。
 */
const prefix = '[DSHA_WARMUP] ';
function emit(message, extra) {
  try { process.stdout.write(prefix + JSON.stringify({ message, ...(extra || {}) }) + '\n'); } catch (_) {}
}

// 只在 Web 进程里做（工具子进程不需要，且会拖慢它们）。
if (process.env.DSHA_WEB_GENERATION) {
  try {
    const t0 = Date.now();

    // 1) 预热 Node 的 libc 判定路径（不调用 getReport，只把模块缓存建起来）。
    //    同时验证「无 getReport」的判据在本环境下的结论，便于诊断。
    let libc = 'unknown';
    try {
      const fs = require('node:fs');
      const markers = [
        '/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-aarch64.so.1',
        '/lib/ld-linux-armhf.so.3', '/lib/ld-linux.so.3',
        '/usr/lib/aarch64-linux-gnu/libc.so.6', '/lib/aarch64-linux-gnu/libc.so.6',
        '/usr/lib/x86_64-linux-gnu/libc.so.6', '/lib/x86_64-linux-gnu/libc.so.6',
        '/etc/ld.so.cache',
      ];
      for (const marker of markers) if (fs.existsSync(marker)) { libc = 'glibc'; break; }
      if (libc === 'unknown') libc = 'musl';
    } catch (_) {}

    // 建立锚定在 dsh 安装树上的 require：warmup 自身不在 dsh 树里，
    // createRequire(__filename) 解析不到 @deepseek-ai/* 模块。
    const { createRequire } = require('node:module');
    const path = require('node:path');
    const fs2 = require('node:fs');
    const dshRequire = (() => {
      const candidates = [];
      try { candidates.push(require.resolve('@deepseek-ai/dsh/package.json')); } catch (_) {}
      try {
        candidates.push(path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules',
                                  '@deepseek-ai/dsh/package.json'));
      } catch (_) {}
      candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
      candidates.push('/opt/node/lib/node_modules/@deepseek-ai/dsh/package.json');
      for (const candidate of candidates) {
        try { if (fs2.existsSync(candidate)) return createRequire(candidate); } catch (_) {}
      }
      return null;
    })();

    // 2) 预热 flock 原生绑定：走一次 loadBinding()，把原生 .node 模块加载进缓存。
    //    在应用了 B 补丁之后，它不再调用 getReport()，因此应当很快。
    let flockMs = null, flockError = null;
    if (!dshRequire) {
      flockError = 'dsh 安装树未找到，跳过原生绑定预热';
    } else {
      try {
        const t1 = Date.now();
        const mod = dshRequire('@deepseek-ai/node-addon-system/flock');
        flockMs = Date.now() - t1;
        // tryLockExclusive 内部才会 loadBinding；用无效 fd 触发加载（会失败但已完成加载）。
        try { mod.tryLockExclusive(-1).catch(() => {}); } catch (_) {}
      } catch (error) {
        flockError = String((error && error.message) || error);
      }
    }

    // 3) 预热会话持久化模块（flock 的实际使用者，首次 require 也有开销）。
    let sessionMs = null;
    if (dshRequire) {
      try {
        const t2 = Date.now();
        dshRequire('@deepseek-ai/dsh-session-persistence-jsonl');
        sessionMs = Date.now() - t2;
      } catch (_) {}
    }

    emit('启动预热完成', { totalMs: Date.now() - t0, libc, flockLoadMs: flockMs,
                           flockError, sessionLoadMs: sessionMs });
  } catch (error) {
    emit('启动预热跳过', { error: String((error && error.message) || error) });
  }
}
