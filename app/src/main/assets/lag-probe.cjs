'use strict';
/*
 * DSHA 卡顿诊断探针（服务端侧）
 *
 * 目标：在一次运行里把「Web 后端为什么卡」的全部可观测面记录下来，供事后分析。
 * 卡顿点可能很隐蔽，因此本探针不预设结论，只做尽可能全面的量化：
 *
 *   1. 事件循环延迟（event loop lag）——最直接的「卡」指标
 *      · 全量样本 + 分位数(P50/P90/P99/max) + 超阈值计数 + 最差 N 次的时间戳
 *      · 区分「空闲期」与「有请求期」，因为只有前者才反映后台轮询污染
 *   2. 定时器抖动：实际周期 vs 期望周期（轮询任务的执行偏差）
 *   3. fs 系统调用：按操作、按调用栈聚合次数与耗时（定位海量 stat）
 *   4. 采样时刻的运行时快照：内存、GC、句柄/线程、CPU
 *   5. 活动 handle / 定时器清单：谁在持续占着事件循环
 *   6. 插件与客户端模块图：数量、体积、解析来源
 *   7. proot/容器特征：哪些路径的 fs 调用特别慢（穿透开销）
 *
 * 输出：JSON 到 stdout（由宿主写入文件），同时写一份 /root/.dsha-lag-probe.json
 * 用法：node /root/.dsh/lag-probe.cjs <采样秒数>
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SECONDS = Math.max(5, Math.min(600, parseInt(process.argv[2] || '30', 10) || 30));
const HOME = process.env.DSH_HOME || '/root/.dsh';
const PROFILE = path.join(HOME, 'profiles', process.env.DSHA_STARTUP_PROFILE || 'web');
const OUT_FILE = '/root/.dsha-lag-probe.json';
const OUT_TMP = OUT_FILE + '.tmp';

const report = {
  schema: 1,
  kind: 'dsha-lag-probe',
  generatedAt: new Date().toISOString(),
  durationSeconds: SECONDS,
  probe: { pid: process.pid, ppid: process.ppid, node: process.version, argv: process.argv.slice(0, 4) },
  environment: {},
  eventLoop: {},
  timers: {},
  fs: {},
  runtime: {},
  handles: {},
  plugins: {},
  rootfs: {},
  notes: [],
};

function nowNs() { return process.hrtime.bigint(); }
function msOf(ns) { return Number(ns) / 1e6; }
function quantiles(sorted) {
  if (!sorted.length) return { count: 0 };
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: +sorted[0].toFixed(2), p50: +at(0.5).toFixed(2), p90: +at(0.9).toFixed(2),
    p99: +at(0.99).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2),
    mean: +(sum / sorted.length).toFixed(2), sum: +sum.toFixed(2),
  };
}

/* ---------- 1. 环境 ---------- */
function collectEnvironment() {
  const e = report.environment;
  e.dshHome = HOME;
  e.profileDir = PROFILE;
  e.dshVersion = process.env.DSHA_DSH_VERSION || null;
  e.dnsMode = process.env.DSHA_DNS_MODE || '(unset)';
  e.nodeOptions = process.env.NODE_OPTIONS || '(unset)';
  e.permissionMode = process.env.DSH_PERMISSION_MODE || '(unset)';
  e.confirm = process.env.DSH_CONFIRM || '(unset)';
  e.dshaAndroidRuntime = process.env.DSHA_ANDROID_RUNTIME || '(unset)';
  e.narbDisableNativeCache = process.env.NARB_DISABLE_NATIVE_CACHE || '(unset)';
  e.uptimeSeconds = +process.uptime().toFixed(1);
  e.loadavg = os.loadavg ? os.loadavg().map(v => +v.toFixed(2)) : null;
  e.cpuCount = os.cpus() ? os.cpus().length : null;
  e.totalMemMiB = Math.round(os.totalmem() / 1048576);
  e.freeMemMiB = Math.round(os.freemem() / 1048576);
  e.lagProbeLoadedAt = new Date().toISOString();
  e.arch = process.arch;
  e.platform = process.platform;
  try { e.resolvConf = fs.readFileSync('/etc/resolv.conf', 'utf8').slice(0, 800); } catch { e.resolvConf = '(unreadable)'; }
}

/* ---------- 2. 事件循环延迟 ---------- */
// 用 setTimeout 链测「期望触发时间 vs 实际触发时间」的差值；这是最标准的 lag 度量。
function startEventLoopSampling() {
  const samples = [];       // {ms, at}
  const worst = [];         // 最差 10 次
  const INTERVAL = 20;      // 20ms 探测周期，足以抓到 100ms 级阻塞
  let expected = Date.now() + INTERVAL;
  let timer = null;
  let stopped = false;

  function tick() {
    if (stopped) return;
    const actual = Date.now();
    const lag = Math.max(0, actual - expected);
    samples.push(lag);
    if (worst.length < 10 || lag > worst[worst.length - 1].ms) {
      worst.push({ ms: +lag.toFixed(1), at: new Date(actual).toISOString(), sinceStartMs: actual - startAt });
      worst.sort((a, b) => b.ms - a.ms);
      if (worst.length > 10) worst.length = 10;
    }
    expected = Date.now() + INTERVAL;
    timer = setTimeout(tick, INTERVAL);
  }
  const startAt = Date.now();
  timer = setTimeout(tick, INTERVAL);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const sorted = samples.slice().sort((a, b) => a - b);
      report.eventLoop = {
        probeIntervalMs: INTERVAL,
        sampleCount: samples.length,
        ...quantiles(sorted),
        over50ms: samples.filter(v => v > 50).length,
        over100ms: samples.filter(v => v > 100).length,
        over250ms: samples.filter(v => v > 250).length,
        over500ms: samples.filter(v => v > 500).length,
        over1000ms: samples.filter(v => v > 1000).length,
        worst,
        histogram: {
          '0-10': samples.filter(v => v < 10).length,
          '10-25': samples.filter(v => v >= 10 && v < 25).length,
          '25-50': samples.filter(v => v >= 25 && v < 50).length,
          '50-100': samples.filter(v => v >= 50 && v < 100).length,
          '100-250': samples.filter(v => v >= 100 && v < 250).length,
          '250-500': samples.filter(v => v >= 250 && v < 500).length,
          '500+': samples.filter(v => v >= 500).length,
        },
      };
    },
  };
}

/* ---------- 3. fs 调用统计 ---------- */
// 按「操作类型」和「调用栈帧」两个维度聚合；后者用于定位是谁在疯狂调 fs。
function instrumentFs() {
  const byOp = new Map();     // op -> {count, ms}
  const byFrame = new Map();  // "frame" -> {count, ms, op}
  const byFrameOp = new Map();// "frame|op" -> {count, ms}
  const slowest = [];         // 单次最慢的 20 次
  const pathHits = new Map(); // 顶层路径前缀 -> count（判断是否是 proot 穿透）

  function frameKey() {
    const err = new Error();
    const stack = (err.stack || '').split('\n');
    // 跳过本包装帧，取第一个「非探针自身」的帧作为归属
    for (let i = 2; i < Math.min(stack.length, 8); i++) {
      const line = stack[i];
      if (!line || line.includes('lag-probe.cjs')) continue;
      const m = line.match(/at\s+(.*?)\s+\(/);
      const where = m ? m[1] : line.trim();
      const loc = (line.match(/\(([^)]+)\)/) || [])[1] || '';
      const base = loc.split('/').slice(-2).join('/');
      return (where + ' ' + base).slice(0, 90) || 'unknown';
    }
    return 'unknown';
  }

  function topPathPrefix(p) {
    if (typeof p !== 'string') return '(nonstring)';
    const parts = p.split('/').filter(Boolean);
    return '/' + parts.slice(0, 2).join('/');
  }

  // 统一包装 fs 上的同步方法
  for (const op of ['statSync','lstatSync','readFileSync','readdirSync','existsSync','realpathSync',
                    'readlinkSync','openSync','accessSync','opendirSync','writeFileSync','mkdirSync',
                    'unlinkSync','copyFileSync','renameSync']) {
    const original = fs[op];
    if (typeof original !== 'function') continue;
    fs[op] = function (...args) {
      const t0 = nowNs();
      let frame = null;
      try {
        if (instrumentFs.active) frame = frameKey();
        return original.apply(fs, args);
      } finally {
        if (instrumentFs.active) {
          const dt = msOf(nowNs() - t0);
          const row = byOp.get(op) || { count: 0, ms: 0 };
          row.count++; row.ms += dt; byOp.set(op, row);
          if (frame) {
            const fr = byFrame.get(frame) || { count: 0, ms: 0, op };
            fr.count++; fr.ms += dt; byFrame.set(frame, fr);
            const key = frame + '|' + op;
            const fo = byFrameOp.get(key) || { count: 0, ms: 0 };
            fo.count++; fo.ms += dt; byFrameOp.set(key, fo);
          }
          const pfx = topPathPrefix(args[0]);
          pathHits.set(pfx, (pathHits.get(pfx) || 0) + 1);
          if (dt > 30) {
            slowest.push({ op, ms: +dt.toFixed(1), frame: frame || 'unknown', path: String(args[0]).slice(0, 160),
                           at: new Date().toISOString() });
            slowest.sort((a, b) => b.ms - a.ms);
            if (slowest.length > 20) slowest.length = 20;
          }
        }
      }
    };
    Object.assign(fs[op], original);
  }
  try { require('node:module').syncBuiltinESMExports(); } catch {}

  instrumentFs.active = false;

  return {
    enable() { instrumentFs.active = true; },
    disable() { instrumentFs.active = false; },
    snapshot(label) {
      const ops = [...byOp.entries()].map(([op, v]) => ({ op, count: v.count, ms: +v.ms.toFixed(1) }))
        .sort((a, b) => b.ms - a.ms);
      const frames = [...byFrame.entries()].map(([frame, v]) => ({ frame, count: v.count, ms: +v.ms.toFixed(1) }))
        .sort((a, b) => b.ms - a.ms).slice(0, 25);
      const framesByOp = [...byFrameOp.entries()].map(([k, v]) => {
        const [frame, op] = k.split('|');
        return { frame, op, count: v.count, ms: +v.ms.toFixed(1) };
      }).sort((a, b) => b.ms - a.ms).slice(0, 25);
      const paths = [...pathHits.entries()].map(([p, c]) => ({ pathPrefix: p, count: c }))
        .sort((a, b) => b.count - a.count).slice(0, 20);
      report.fs[label] = {
        byOperation: ops,
        byCallFrame: frames,
        byCallFrameAndOperation: framesByOp,
        topPathPrefixes: paths,
        slowestCalls: slowest,
      };
    },
  };
}

/* ---------- 4. 运行时快照 ---------- */
function collectRuntime(label) {
  const snap = { at: new Date().toISOString() };
  try {
    const mu = process.memoryUsage();
    snap.memoryMiB = {
      rss: +(mu.rss / 1048576).toFixed(1),
      heapTotal: +(mu.heapTotal / 1048576).toFixed(1),
      heapUsed: +(mu.heapUsed / 1048576).toFixed(1),
      external: +(mu.external / 1048576).toFixed(1),
      arrayBuffers: +(mu.arrayBuffers / 1048576).toFixed(1),
    };
  } catch (e) { snap.memoryError = String(e); }
  try {
    const perf = require('node:perf_hooks').performance;
    const el = perf.eventLoopUtilization ? perf.eventLoopUtilization() : null;
    if (el) snap.eventLoopUtilization = { utilization: +el.utilization.toFixed(4), activeMs: Math.round(el.active), idleMs: Math.round(el.idle) };
  } catch {}
  try {
    const v8 = require('node:v8');
    const hs = v8.getHeapStatistics();
    snap.heap = {
      totalAvailableMiB: +(hs.total_available_size / 1048576).toFixed(1),
      usedHeapMiB: +(hs.used_heap_size / 1048576).toFixed(1),
      heapSizeLimitMiB: +(hs.heap_size_limit / 1048576).toFixed(1),
      mallocedMiB: +(hs.malloced_memory / 1048576).toFixed(1),
      peakMallocedMiB: +(hs.peak_malloced_memory / 1048576).toFixed(1),
      nativeContexts: hs.number_of_native_contexts,
      detachedContexts: hs.number_of_detached_contexts,
    };
  } catch {}
  try { snap.activeHandles = process._getActiveHandles ? process._getActiveHandles().length : null; } catch {}
  try { snap.activeRequests = process._getActiveRequests ? process._getActiveRequests().length : null; } catch {}
  try { const c = process.cpuUsage(); snap.cpu = { userMs: +(c.user / 1000).toFixed(0), systemMs: +(c.system / 1000).toFixed(0) }; } catch {}
  try {
    snap.threads = fs.existsSync('/proc/self/status')
      ? (fs.readFileSync('/proc/self/status', 'utf8').match(/Threads:\s*(\d+)/) || [])[1] : null;
    snap.voluntaryCtxSwitches = fs.existsSync('/proc/self/status')
      ? (fs.readFileSync('/proc/self/status', 'utf8').match(/voluntary_ctxt_switches:\s*(\d+)/) || [])[1] : null;
    snap.nonvoluntaryCtxSwitches = fs.existsSync('/proc/self/status')
      ? (fs.readFileSync('/proc/self/status', 'utf8').match(/nonvoluntary_ctxt_switches:\s*(\d+)/) || [])[1] : null;
  } catch {}
  // 自读 /proc/self/stat 计算真实 CPU（jiffies）
  try {
    const st = fs.readFileSync('/proc/self/stat', 'utf8');
    const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
    snap.procStat = { utime: +f[11], stime: +f[12], numThreads: +f[17], vsizeBytes: +f[20] };
  } catch {}
  report.runtime[label] = snap;
}

/* ---------- 5. 定时器 / handle 清单 ---------- */
function collectHandles() {
  const out = { timers: [], handles: [], requests: [] };
  try {
    const timerList = process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : [];
    const counts = {};
    for (const name of timerList) counts[name] = (counts[name] || 0) + 1;
    out.activeResourceCounts = counts;
    out.activeResourceTotal = timerList.length;
  } catch {}
  try {
    const handles = process._getActiveHandles ? process._getActiveHandles() : [];
    for (const h of handles) {
      const entry = { type: h && h.constructor ? h.constructor.name : typeof h };
      try {
        if (typeof h.msecs === 'number') { entry.msecs = h.msecs; entry.repeat = h._repeat; }
        if (h.fd !== undefined) entry.fd = h.fd;
        if (h.localPort !== undefined) entry.localPort = h.localPort;
      } catch {}
      out.handles.push(entry);
    }
  } catch (e) { out.handlesError = String(e); }
  report.handles = out;
}

/* ---------- 6. 插件与客户端模块 ---------- */
function collectPlugins() {
  const p = report.plugins;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
    p.bundleNames = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
    p.bundleCount = p.bundleNames.length;
    p.patchReload = manifest.dsh && manifest.dsh.profile ? manifest.dsh.profile.patchReload : null;
    p.dependencies = Object.keys(manifest.dependencies || {}).length;
  } catch (e) { p.manifestError = String(e); }
  // 逐个 bundle 统计体积与解析位置（体积大 = 加载慢）
  const sizes = [];
  for (const name of (p.bundleNames || [])) {
    try {
      let root = null;
      for (const anchor of ['/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json', path.join(PROFILE, 'package.json')]) {
        const paths = require('node:module').createRequire(anchor).resolve.paths(name) || [];
        for (const base of paths) {
          const cand = path.join(base, name);
          if (fs.existsSync(path.join(cand, 'package.json'))) { root = fs.realpathSync(cand); break; }
        }
        if (root) break;
      }
      if (!root) { sizes.push({ name, resolved: false }); continue; }
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      sizes.push({ name, resolved: true, directory: root, version: pkg.version || null });
    } catch (e) { sizes.push({ name, error: String(e).slice(0, 120) }); }
  }
  p.bundles = sizes;
  // cordis.patch.yml 是否含 hmr 覆盖（本次修复点）
  try {
    const patchPath = path.join(PROFILE, 'cordis.patch.yml');
    const text = fs.readFileSync(patchPath, 'utf8');
    p.cordisPatch = { bytes: text.length, hasClientHmrOverride: /id:\s*client-hmr/.test(text),
                      pollIntervalOverride: (text.match(/pollIntervalMs:\s*(\d+)/) || [])[1] || null };
  } catch (e) { p.cordisPatchError = String(e); }
  // hmr 模块当前生效的默认轮询值（验证补丁是否真的应用了）
  // dsh 安装树位置随版本/镜像不同（/usr/local、/opt 等），逐个候选搜索，
  // 并额外通过 require.resolve 定位，避免"探针自己找不到模块"这种假阴性。
  try {
    const candidates = [];
    try { candidates.push(require.resolve('@deepseek-ai/dsh-client-hmr/lib/index.js')); } catch {}
    try {
      const req = require('node:module').createRequire(
        '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
      candidates.push(req.resolve('@deepseek-ai/dsh-client-hmr/lib/index.js'));
    } catch {}
    // 兜底：在常见安装根下用 realpath 搜索
    for (const base of ['/usr/local/lib/node_modules', '/opt/node/lib/node_modules',
                        process.env.DSHA_DSH_ROOT || '']) {
      if (!base) continue;
      candidates.push(path.join(base, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js'));
    }
    // 更可靠：从「正在运行的 dsh 入口」与「node 可执行文件位置」推导安装根。
    // dsh 入口可能是 .../lib/node_modules/@deepseek-ai/dsh/lib/bin.js
    try {
      const entry = process.argv[1] || '';
      const marker = '/node_modules/';
      const at = entry.lastIndexOf(marker);
      if (at > 0) {
        const root = entry.slice(0, at + marker.length - 1); // .../lib/node_modules
        candidates.push(path.join(root, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js'));
        candidates.push(path.join(root, '@deepseek-ai/dsh-client-hmr/lib/index.js'));
      }
    } catch {}
    try {
      // process.execPath = /opt/node-vX/bin/node → 上两级 + /lib/node_modules
      const nodeRoot = path.dirname(path.dirname(process.execPath));
      candidates.push(path.join(nodeRoot, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js'));
      candidates.push(path.join(nodeRoot, 'lib/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js'));
    } catch {}
    // 还找不到就扫描 node_modules 一层（慢但只在失败时做）
    let found = candidates.find(c => { try { return fs.existsSync(c); } catch { return false; } });
    if (!found) {
      for (const base of ['/usr/local/lib/node_modules', '/opt']) {
        try {
          const dshEntries = fs.readdirSync(base).filter(n => n.includes('node_modules') || n.includes('dsh'));
          for (const e of dshEntries) {
            const guess = path.join(base, e, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js');
            if (fs.existsSync(guess)) { found = guess; break; }
          }
        } catch {}
        if (found) break;
      }
    }
    if (found) {
      const real = fs.realpathSync(found);
      const t = fs.readFileSync(real, 'utf8');
      p.clientHmr = {
        path: real,
        candidatesProbed: candidates.length,
        defaultPollIntervalMs: (t.match(/pollIntervalMs:[^;]*?default\((\d+)\)/) || [])[1] || null,
        patchMarkerPresent: t.includes('DSHA_HMR_POLL_INTERVAL_V1'),
        moduleBytes: t.length,
      };
    } else {
      p.clientHmr = { missing: true, candidatesProbed: candidates.map(c => String(c).slice(0, 120)) };
    }
  } catch (e) { p.clientHmrError = String(e); }
}

/* ---------- 7. rootfs 穿透开销 ---------- */
// 对几个关键路径做重复 stat，测「单次穿透耗时」，量化 proot 开销。
function measureRootfsLatency() {
  const targets = [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js',
    path.join(PROFILE, 'package.json'),
    path.join(PROFILE, 'node_modules'),
    '/etc/resolv.conf',
    '/root/.dsh',
  ];
  const rows = [];
  for (const t of targets) {
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const t0 = nowNs();
      try { fs.statSync(t); } catch {}
      samples.push(msOf(nowNs() - t0));
    }
    samples.sort((a, b) => a - b);
    rows.push({ path: t, ...quantiles(samples) });
  }
  report.rootfs = { statLatencyByPath: rows };
}


/* ---------- 9. 外部观测正在运行的 Web 进程 ---------- */
// 关键：用户「正在用」的那个 dsh 实例无法被本进程注入，所以从外部观测它：
// 读它的 /proc（CPU/内存/线程/上下文切换），并对它的端口持续发请求测延迟时间线。
function readProc(pid, label) {
  const out = { pid, label, at: new Date().toISOString() };
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const pick = (re) => (status.match(re) || [])[1] || null;
    out.threads = pick(/Threads:\s*(\d+)/);
    out.vmRssMiB = pick(/VmRSS:\s*(\d+)/) ? +(pick(/VmRSS:\s*(\d+)/) / 1024).toFixed(1) : null;
    out.vmSizeMiB = pick(/VmSize:\s*(\d+)/) ? +(pick(/VmSize:\s*(\d+)/) / 1024).toFixed(1) : null;
    out.voluntaryCtx = pick(/voluntary_ctxt_switches:\s*(\d+)/);
    out.nonvoluntaryCtx = pick(/nonvoluntary_ctxt_switches:\s*(\d+)/);
    out.rssAnon = pick(/RssAnon:\s*(\d+)/) ? +(pick(/RssAnon:\s*(\d+)/) / 1024).toFixed(1) : null;
  } catch (e) { out.statusError = String(e).slice(0, 80); }
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
    out.procStat = { utime: +f[11], stime: +f[12], numThreads: +f[17], starttime: +f[19],
                     vsize: +f[20], rssPages: +f[21] };
  } catch (e) { out.statError = String(e).slice(0, 80); }
  try {
    const io = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
    const pick = (re) => (io.match(re) || [])[1] || null;
    out.io = { readBytes: pick(/read_bytes:\s*(\d+)/), writeBytes: pick(/write_bytes:\s*(\d+)/),
               syscallRead: pick(/syscr:\s*(\d+)/), syscallWrite: pick(/syscw:\s*(\d+)/) };
  } catch (e) { out.ioError = String(e).slice(0, 60); }
  try {
    const fd = fs.readdirSync(`/proc/${pid}/fd`).length;
    out.openFds = fd;
  } catch {}
  try {
    const sched = fs.readFileSync(`/proc/${pid}/schedstat`, 'utf8').trim().split(' ');
    out.schedstat = { runTimeMs: +(sched[0] / 1e6).toFixed(0), waitTimeMs: +(sched[1] / 1e6).toFixed(0), timeslices: +sched[2] };
  } catch {}
  return out;
}

function findWebProcesses() {
  const found = [];
  let names = [];
  try { names = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch { return found; }
  for (const n of names) {
    try {
      const cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      if (!cmd.includes('dsh') && !cmd.includes('node')) continue;
      // 端口从命令行提取
      const port = (cmd.match(/--port\s+(\d+)/) || [])[1] || null;
      const isProotLauncher = cmd.includes('proot') && !cmd.includes('node');
      if (isProotLauncher) continue;
      const entry = readProc(n, cmd.slice(0, 120));
      entry.dshPort = port;
      entry.isDshWeb = cmd.includes('dsh') || cmd.includes('bin.js');
      found.push(entry);
    } catch {}
  }
  return found;
}

// 对端口做延迟时间线采样：发现周期性尖峰（卡的直接证据）
async function sampleHttpLatency(port, seconds) {
  const samples = [];
  const deadline = Date.now() + seconds * 1000;
  const url = `http://127.0.0.1:${port}/`;
  while (Date.now() < deadline) {
    const t0 = nowNs();
    let status = 0, bytes = 0, error = null;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(url, { redirect: 'manual', signal: ctl.signal });
      status = res.status;
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = buf.length;
      clearTimeout(to);
    } catch (e) { error = e.name || String(e); }
    samples.push({ ms: +msOf(nowNs() - t0).toFixed(1), status, bytes, error,
                   at: new Date().toISOString() });
    await new Promise(r => setTimeout(r, 50));
  }
  const ms = samples.map(x => x.ms).sort((a, b) => a - b);
  const over = (t) => samples.filter(x => x.ms > t).map(x => ({ ms: x.ms, at: x.at }));
  return {
    port, probeUrl: url, sampleCount: samples.length,
    ...quantiles(ms),
    over50ms: over(50), over100ms: over(100), over250ms: over(250), over500ms: over(500),
    errors: samples.filter(x => x.error).map(x => ({ error: x.error, at: x.at })).slice(0, 20),
    emptyResponses: samples.filter(x => !x.error && x.bytes === 0).length,
    timelineMs: samples.map(x => x.ms),
  };
}

/* ---------- 8. 主流程 ---------- */
function main() {
  collectEnvironment();
  const fsProbe = instrumentFs();
  measureRootfsLatency();
  const loop = startEventLoopSampling();
  collectRuntime('atStart');
  collectHandles();
  collectPlugins();

  // 外部观测：正在运行的 dsh/web 进程（含用户当前实例）
  const external = { processes: findWebProcesses(), samples: [] };
  const extTimer = setInterval(() => {
    try { external.samples.push({ at: new Date().toISOString(), processes: findWebProcesses() }); }
    catch {}
  }, 2000);
  external.samples.push({ at: new Date().toISOString(), processes: external.processes });

  // HTTP 延迟时间线：优先测当前 profile 的 3080（DSHA 默认端口）
  const httpPorts = [3080, 3081, 3090].filter(p => p);
  const httpResults = [];
  (async () => {
    for (const port of httpPorts) {
      try {
        const r = await sampleHttpLatency(port, Math.max(4, Math.round(SECONDS / httpPorts.length)));
        httpResults.push(r);
      } catch (e) { httpResults.push({ port, error: String(e) }); }
    }
  })();

  setTimeout(() => { fsProbe.enable(); collectRuntime('atHalf'); }, Math.round(SECONDS * 1000 / 2));

  setTimeout(async () => {
    clearInterval(extTimer);
    loop.stop();
    fsProbe.snapshot('window');
    collectRuntime('atEnd');
    collectHandles();
    report.externalObservations = {
      processCount: external.processes.length,
      processes: external.processes,
      samples: external.samples.slice(0, Math.max(2, Math.round(SECONDS / 2))),
    };
    report.httpLatency = httpResults;

    const el = report.eventLoop;
    const notes = report.notes;
    notes.push(`采样 ${SECONDS}s，事件循环延迟 P50=${el.p50}ms P99=${el.p99}ms max=${el.max}ms`);
    if (el.over100ms > 0) notes.push(`发生 ${el.over100ms} 次 >100ms 阻塞，最差 ${el.max}ms`);
    const fsOps = (report.fs.window && report.fs.window.byOperation) || [];
    const statRow = fsOps.find(r => r.op === 'statSync');
    if (statRow && statRow.count > 0) notes.push(`窗口内 statSync ${statRow.count} 次 / ${statRow.ms}ms`);
    if (report.plugins.clientHmr && report.plugins.clientHmr.defaultPollIntervalMs)
      notes.push(`client-hmr 生效轮询间隔 = ${report.plugins.clientHmr.defaultPollIntervalMs}ms（补丁标记 ${report.plugins.clientHmr.patchMarkerPresent}）`);
    if (report.plugins.cordisPatch)
      notes.push(`profile 覆盖 pollIntervalMs = ${report.plugins.cordisPatch.pollIntervalOverride || '无'}（id:client-hmr ${report.plugins.cordisPatch.hasClientHmrOverride}）`);
    for (const h of httpResults) {
      if (h.error) { notes.push(`HTTP :${h.port} 采样失败 ${h.error}`); continue; }
      notes.push(`HTTP :${h.port} 延迟 P50=${h.p50}ms P99=${h.p99}ms max=${h.max}ms（${h.sampleCount} 样本，>100ms ${h.over100ms.length} 次）`);
    }
    if (external.processes.length) {
      const top = external.processes.slice().sort((a, b) => (b.procStat?.utime + b.procStat?.stime || 0) - (a.procStat?.utime + a.procStat?.stime || 0))[0];
      const u = top.procStat?.utime || 0, sy = top.procStat?.stime || 0;
      notes.push(`外部观测到 ${external.processes.length} 个 dsh/node 进程；CPU 最高者 pid=${top.pid} utime=${u} stime=${sy} 线程=${top.threads} RSS=${top.vmRssMiB}MiB`);
      if (sy > u * 2 && sy > 100) notes.push(`该进程 stime(${sy}) 远高于 utime(${u})，系统调用占比过高（典型 fs 穿透开销）`);
    }

    const text = JSON.stringify(report, null, 2) + '\n';
    try { fs.writeFileSync(OUT_TMP, text, { mode: 0o600 }); fs.renameSync(OUT_TMP, OUT_FILE); }
    catch (e) { process.stderr.write('lag-probe write failed: ' + e + '\n'); }
    process.stdout.write(text);
    process.exit(0);
  }, Math.round(SECONDS * 1000));
}

main();
