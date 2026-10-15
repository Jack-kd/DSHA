/**
 * DSHA 卡顿采样器 —— 运行在 dsh web 进程【内部】。
 *
 * 为什么必须在进程内：卡顿 = dsh 的事件循环被阻塞。独立进程测的是它自己的循环，
 * 永远看不到 dsh 的阻塞。本模块作为 cordis 插件挂在 dsh 进程里，才拿得到真实数据。
 *
 * 两条互补的证据链：
 *   1. 【CPU 采样剖析】node:inspector 的 Profiler —— 给出「哪个函数/哪一行在烧 CPU」
 *      的函数级自耗时归因，能看到 GC、用户代码、插件代码、库代码。
 *      这是定位「隐蔽卡顿点」最有力的工具。
 *   2. 【事件循环延迟】20ms setTimeout 链 —— 给出「卡多久、多频繁」的时间形状
 *      （分位数、直方图、最差时刻），与剖析互补。
 * 另附：定时器抖动、fs 计数、进程 CPU（/proc/self 差值）、内存/句柄/上下文切换。
 *
 * 触发方式：宿主写 /root/.dsha-lag-request.json {nonce, seconds}，
 * 采样器在指定窗口内采集，结果写 /root/.dsha-lag-result.json。
 * 全程 try/catch，绝不因采样失败影响 dsh 运行。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as pathUtil from 'node:path';

// ESM 里没有裸 require；统一用 createRequire 获取 CJS 形态的内置模块
// （node:inspector / node:fs 本体 / node:v8 / node:perf_hooks 都要通过它拿）。
const cjsRequire = createRequire(import.meta.url);

const REQUEST = '/root/.dsha-lag-request.json';
const RESULT = '/root/.dsha-lag-result.json';
const RESULT_TMP = RESULT + '.tmp';
const POLL_MS = 400;
const MAX_PROFILE_NODES = 4000;

const quantiles = (sorted) => {
  if (!sorted.length) return { count: 0 };
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: +sorted[0].toFixed(2), p50: +at(0.5).toFixed(2), p90: +at(0.9).toFixed(2),
    p99: +at(0.99).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2),
    mean: +(sum / sorted.length).toFixed(2), sum: +sum.toFixed(2),
  };
};

const ring = { lag: [] };
const pushLag = (v) => { ring.lag.push(v); if (ring.lag.length > 6000) ring.lag.shift(); };

/** fs 累计计数（常驻轻量），用于窗口差值。fs 模块通过 createRequire 获取本体。 */
const fsCounters = new Map();
let fsModule = null;
let fsPatched = false;
function patchFs() {
  if (fsPatched || !fsModule) return;
  fsPatched = true;
  for (const op of ['statSync','lstatSync','readFileSync','readdirSync','existsSync','realpathSync',
                    'readlinkSync','openSync','accessSync','writeFileSync','mkdirSync','unlinkSync',
                    'copyFileSync','renameSync']) {
    const original = fsModule[op];
    if (typeof original !== 'function') continue;
    const wrapped = function (...args) {
      const t0 = process.hrtime.bigint();
      try { return original.apply(fsModule, args); }
      finally {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const row = fsCounters.get(op) || { count: 0, ms: 0 };
        row.count++; row.ms += ms;
        fsCounters.set(op, row);
      }
    };
    Object.assign(wrapped, original);
    try { fsModule[op] = wrapped; } catch {}
  }
  try { cjsRequire('node:module').syncBuiltinESMExports(); } catch {}
}

/** 事件循环延迟探测。 */
function startLagProbe(intervalMs, sink) {
  let expected = Date.now() + intervalMs;
  let timer = null, stopped = false;
  const tick = () => {
    if (stopped) return;
    const actual = Date.now();
    sink(Math.max(0, actual - expected));
    expected = Date.now() + intervalMs;
    timer = setTimeout(tick, intervalMs);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(tick, intervalMs);
  if (timer.unref) timer.unref();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}


/**
 * 客户端 bundle 体积分析 —— 定位「点设置/工作区为什么要等」。
 *
 * 背景（实测发现）：dsh 把每个客户端插件编成独立的 client.js，由 HTTP 逐个提供，
 * 且【不做压缩】（serveBundle 直接 res.end，无 gzip/br）。浏览器进 Web 要下载并
 * 解析全部 bundle；其中 dsh-client-ui-settings-account 达 5.03MB，且内含 8 张
 * base64 PNG 欢迎图（合计 3.63MB）—— 点「设置」必然要下载解析它，这就是卡顿源之一。
 *
 * 本函数把这些包的体积、内嵌 base64 占比、以及 HTTP 服务端是否压缩记录下来，
 * 供报告直接定位「哪个包、哪类内容」造成加载慢。
 */
function analyzeClientBundles() {
  const out = { bundles: [], totals: {}, compressedTransport: null, findings: [] };
  // 用 fs 模块【本体】（CJS 引用）而不是 ESM import 绑定：patchFs 替换的是本体上的
  // 方法，ESM 绑定是否同步取决于 syncBuiltinESMExports；直接用本体可避免这种歧义。
  const F = fsModule || cjsRequire('node:fs');
  if (!fsModule) fsModule = F;
  const roots = [];
  const candidates = [];
  try { candidates.push(pathUtil.dirname(cjsRequire.resolve('@deepseek-ai/dsh/package.json'))); } catch {}
  try {
    const entry = process.argv[1] || '';
    const at = entry.lastIndexOf('/node_modules/');
    if (at > 0) candidates.push(entry.slice(0, at));
  } catch {}
  try { candidates.push(pathUtil.join(pathUtil.dirname(pathUtil.dirname(process.execPath)), 'lib', 'node_modules')); } catch {}
  try {
    // dsh 也可能从当前工作目录的 node_modules 解析（pnpm link 场景）
    candidates.push(pathUtil.join(process.cwd(), 'node_modules'));
  } catch {}
  for (const base of candidates) {
    try {
      const dsh = base.endsWith('@deepseek-ai/dsh') ? base : pathUtil.join(base, '@deepseek-ai/dsh');
      if (!F.existsSync(pathUtil.join(dsh, 'package.json'))) continue;
      const scoped = pathUtil.join(dsh, 'node_modules', '@deepseek-ai');
      if (F.existsSync(scoped)) roots.push(scoped);
    } catch {}
  }
  const seen = new Set();
  for (const root of roots) {
    if (seen.has(root)) continue; seen.add(root);
    let names = [];
    try { names = F.readdirSync(root); } catch { continue; }
    let totalBytes = 0, count = 0;
    for (const name of names) {
      const file = pathUtil.join(root, name, 'lib', 'client.js');
      let size = 0;
      try { size = F.statSync(file).size; } catch { continue; }
      totalBytes += size;
      let embedded = 0, images = 0;
      try {
        const text = F.readFileSync(file, 'utf8');
        const matches = text.match(/data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g) || [];
        images = matches.length;
        for (const m of matches) embedded += Math.round(m.length * 3 / 4);
      } catch {}
      count++;
      out.bundles.push({ name, bytes: size, embeddedImageBytes: embedded, inlineImageCount: images,
                         executableBytes: size - embedded });
    }
    out.totals[root] = { bundleCount: count, totalBytes, totalMiB: +(totalBytes / 1048576).toFixed(2) };
  }
  out.bundles.sort((a, b) => b.bytes - a.bytes);
  out.rootsProbed = roots;
  out.bundles = out.bundles.slice(0, 30);

  const grand = Object.values(out.totals).reduce((a, t) => a + (t.totalBytes || 0), 0) || out.bundles.reduce((a, b) => a + b.bytes, 0);
  const grandImg = out.bundles.reduce((a, b) => a + b.embeddedImageBytes, 0);
  out.grandTotalBytes = grand;
  out.grandTotalMiB = +(grand / 1048576).toFixed(2);
  out.embeddedImageMiB = +(grandImg / 1048576).toFixed(2);
  out.embeddedImagePercent = grand ? +((grandImg / grand) * 100).toFixed(1) : 0;
  out.biggest = out.bundles[0] ? { name: out.bundles[0].name, MiB: +(out.bundles[0].bytes / 1048576).toFixed(2) } : null;

  if (out.bundles[0] && out.bundles[0].embeddedImageBytes > 1048576)
    out.findings.push(`最大包 ${out.bundles[0].name} 有 ${(out.bundles[0].embeddedImageBytes/1048576).toFixed(2)}MB 内嵌 base64 图片（点相关页面要下载解析这些）`);
  if (out.embeddedImagePercent > 20)
    out.findings.push(`内嵌 base64 图片占客户端 bundle 总量的 ${out.embeddedImagePercent}%（可外置为文件，避免 JS 解析开销）`);
  if (out.totals[roots[0]] && out.totals[roots[0]].totalMiB > 8)
    out.findings.push(`客户端 bundle 合计 ${out.totals[roots[0]].totalMiB}MiB，且服务端未压缩传输（serveBundle 无 gzip/br）`);
  return out;
}

function procSelf(label) {
  const out = { label, at: new Date().toISOString() };
  try {
    const st = readFileSync('/proc/self/stat', 'utf8');
    const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
    out.utimeJiffies = +f[11]; out.stimeJiffies = +f[12];
    out.threads = +f[17]; out.vsizeBytes = +f[20]; out.rssPages = +f[21];
  } catch {}
  try {
    const s = readFileSync('/proc/self/status', 'utf8');
    const pick = (re) => (s.match(re) || [])[1] || null;
    out.vmRssKiB = pick(/VmRSS:\s*(\d+)/);
    out.voluntaryCtx = pick(/voluntary_ctxt_switches:\s*(\d+)/);
    out.nonvoluntaryCtx = pick(/nonvoluntary_ctxt_switches:\s*(\d+)/);
  } catch {}
  try {
    const io = readFileSync('/proc/self/io', 'utf8');
    const pick = (re) => (io.match(re) || [])[1] || null;
    out.syscr = pick(/syscr:\s*(\d+)/); out.syscw = pick(/syscw:\s*(\d+)/);
    out.readBytes = pick(/read_bytes:\s*(\d+)/); out.writeBytes = pick(/write_bytes:\s*(\d+)/);
  } catch {}
  try {
    const mu = process.memoryUsage();
    out.memoryMiB = { rss: +(mu.rss / 1048576).toFixed(1), heapUsed: +(mu.heapUsed / 1048576).toFixed(1),
                      heapTotal: +(mu.heapTotal / 1048576).toFixed(1), external: +(mu.external / 1048576).toFixed(1),
                      arrayBuffers: +(mu.arrayBuffers / 1048576).toFixed(1) };
  } catch {}
  try {
    const perf = cjsRequire('node:perf_hooks').performance;
    if (perf.eventLoopUtilization) {
      const el = perf.eventLoopUtilization();
      out.eventLoopUtilization = { utilization: +el.utilization.toFixed(4),
                                   activeMs: Math.round(el.active), idleMs: Math.round(el.idle) };
    }
  } catch {}
  try {
    const v8 = cjsRequire('node:v8');
    const hs = v8.getHeapStatistics();
    out.heap = { limitMiB: +(hs.heap_size_limit / 1048576).toFixed(1),
                 usedMiB: +(hs.used_heap_size / 1048576).toFixed(1),
                 mallocedMiB: +(hs.malloced_memory / 1048576).toFixed(1),
                 peakMallocedMiB: +(hs.peak_malloced_memory / 1048576).toFixed(1),
                 nativeContexts: hs.number_of_native_contexts,
                 detachedContexts: hs.number_of_detached_contexts };
  } catch {}
  try { out.activeHandles = process._getActiveHandles ? process._getActiveHandles().length : null; } catch {}
  try {
    if (process.getActiveResourcesInfo) {
      const out2 = {};
      for (const name of process.getActiveResourcesInfo()) out2[name] = (out2[name] || 0) + 1;
      out.activeResources = out2;
    }
  } catch {}
  return out;
}

/** 把 inspector profile 聚合成「函数级自耗时排行」。 */
function summarizeProfile(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfUs = new Map();
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    selfUs.set(id, (selfUs.get(id) || 0) + (deltas[i] || 0));
  }
  const rows = [];
  for (const [id, us] of selfUs) {
    const node = byId.get(id);
    if (!node) continue;
    const cf = node.callFrame || {};
    const url = String(cf.url || '');
    rows.push({
      function: String(cf.functionName || '(anonymous)').slice(0, 120),
      url: url.slice(0, 200),
      shortUrl: url.split('/').slice(-3).join('/'),
      line: cf.lineNumber,
      selfMs: +(us / 1000).toFixed(1),
    });
  }
  rows.sort((a, b) => b.selfMs - a.selfMs);
  // (idle)/(program)/(root) 是 V8 的占位帧，不是可行动的归因；剔除以免掩盖真实热点。
  const idle = rows.find((r) => r.function === '(idle)');
  const actionable = rows.filter((r) => !['(idle)', '(program)', '(root)'].includes(r.function));
  const top = actionable.slice(0, 40);
  // 按模块聚合（同 URL 合并），便于看「哪个包在烧 CPU」
  const byModule = new Map();
  for (const r of rows) {
    const key = r.shortUrl || '(node internal / native)';
    const row = byModule.get(key) || { module: key, selfMs: 0, functions: 0 };
    row.selfMs += r.selfMs; row.functions++;
    byModule.set(key, row);
  }
  const modules = [...byModule.values()].map((r) => ({ ...r, selfMs: +r.selfMs.toFixed(1) }))
    .sort((a, b) => b.selfMs - a.selfMs).slice(0, 30);
  const gc = rows.find((r) => r.function === '(garbage collector)');
  const program = rows.find((r) => r.function === '(program)');
  const totalMs = rows.reduce((a, r) => a + r.selfMs, 0);
  return {
    totalSelfMs: +totalMs.toFixed(1),
    idleSelfMs: idle ? idle.selfMs : 0,
    gcSelfMs: gc ? gc.selfMs : 0,
    programSelfMs: program ? program.selfMs : 0,
    sampleCount: samples.length,
    topFunctions: top,
    byModule: modules,
  };
}

/** 一次完整采集。 */
async function measure(seconds, context) {
  const samples = [], worst = [];
  const startedAt = Date.now();
  const probe = startLagProbe(20, (lag) => {
    samples.push(lag);
    if (worst.length < 12 || lag > worst[worst.length - 1].ms) {
      worst.push({ ms: +lag.toFixed(1), at: new Date().toISOString(), sinceStartMs: Date.now() - startedAt });
      worst.sort((a, b) => b.ms - a.ms);
      if (worst.length > 12) worst.length = 12;
    }
  });

  const fsBefore = new Map();
  for (const [k, v] of fsCounters) fsBefore.set(k, v.count);
  const before = procSelf('atStart');

  // CPU 剖析：整个窗口
  let profileSummary = null, profileError = '';
  let session = null;
  const post = (method, params) => new Promise((resolve, reject) => {
    session.post(method, params || {}, (err, result) => (err ? reject(err) : resolve(result)));
  });
  try {
    const { Session } = cjsRequire('node:inspector');
    session = new Session();
    session.connect();
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 }); // 1ms 采样
    await post('Profiler.start');
  } catch (error) { profileError = String(error && error.message || error); session = null; }

  await new Promise((r) => { const t = setTimeout(r, seconds * 1000); if (t.unref) t.unref(); });

  try {
    if (session) {
      const { profile } = await post('Profiler.stop');
      profileSummary = summarizeProfile(profile);
      if (profileSummary.topFunctions.length > MAX_PROFILE_NODES) profileSummary.topFunctions.length = MAX_PROFILE_NODES;
      try { session.disconnect(); } catch {}
    }
  } catch (error) { profileError = String(error && error.message || error); }

  probe.stop();
  const after = procSelf('atEnd');

  const sorted = samples.slice().sort((a, b) => a - b);
  const fsDelta = [];
  for (const [op, row] of fsCounters) {
    const was = fsBefore.get(op) || 0;
    if (row.count - was > 0) fsDelta.push({ op, count: row.count - was, ms: +row.ms.toFixed(1) });
  }
  fsDelta.sort((a, b) => b.ms - a.ms);

  const secs = seconds;
  const dU = ((after.utimeJiffies || 0) - (before.utimeJiffies || 0)) / 100;
  const dS = ((after.stimeJiffies || 0) - (before.stimeJiffies || 0)) / 100;

  const result = {
    schema: 2,
    kind: 'dsha-lag-sampler',
    nonce: context.nonce,
    generatedAt: new Date().toISOString(),
    durationSeconds: secs,
    process: { pid: process.pid, node: process.version, argv: process.argv.slice(0, 4),
               uptimeSeconds: +process.uptime().toFixed(1),
               dshHome: process.env.DSH_HOME || null, profile: process.env.DSHA_STARTUP_PROFILE || null },
    eventLoop: {
      probeIntervalMs: 20,
      sampleCount: samples.length,
      ...quantiles(sorted),
      over50ms: samples.filter((v) => v > 50).length,
      over100ms: samples.filter((v) => v > 100).length,
      over250ms: samples.filter((v) => v > 250).length,
      over500ms: samples.filter((v) => v > 500).length,
      over1000ms: samples.filter((v) => v > 1000).length,
      histogram: {
        '0-10': samples.filter((v) => v < 10).length,
        '10-25': samples.filter((v) => v >= 10 && v < 25).length,
        '25-50': samples.filter((v) => v >= 25 && v < 50).length,
        '50-100': samples.filter((v) => v >= 50 && v < 100).length,
        '100-250': samples.filter((v) => v >= 100 && v < 250).length,
        '250-500': samples.filter((v) => v >= 250 && v < 500).length,
        '500+': samples.filter((v) => v >= 500).length,
      },
      worst,
      sinceStart: { samples: ring.lag.length, summary: quantiles(ring.lag.slice().sort((a, b) => a - b)) },
    },
    cpuProfile: profileSummary,
    cpuProfileError: profileError || null,
    fs: { byOperation: fsDelta },
    clientBundles: analyzeClientBundles(),
    proc: { before, after },
    cpu: { windowSeconds: secs, userSeconds: +dU.toFixed(2), systemSeconds: +dS.toFixed(2),
           cpuPercent: +(((dU + dS) / secs) * 100).toFixed(2) },
  };

  const notes = [];
  notes.push(`窗口 ${secs}s：事件循环 P50=${result.eventLoop.p50}ms P90=${result.eventLoop.p90}ms P99=${result.eventLoop.p99}ms max=${result.eventLoop.max}ms`);
  if (result.eventLoop.over100ms) notes.push(`${result.eventLoop.over100ms} 次 >100ms 阻塞；最差 ${result.eventLoop.max}ms @ ${result.eventLoop.worst[0]?.at || '?'}`);
  if (profileSummary) {
    notes.push(`CPU 剖析：总自耗时 ${profileSummary.totalSelfMs}ms（采样 ${profileSummary.sampleCount} 次）`);
    if (profileSummary.gcSelfMs > 0) notes.push(`GC 自耗时 ${profileSummary.gcSelfMs}ms`);
    if (profileSummary.idleSelfMs > 0) notes.push(`空闲(idle) ${profileSummary.idleSelfMs}ms（已从热点排名剔除，仅作参考）`);
    if (profileSummary.topFunctions[0])
      notes.push(`最烧 CPU 的函数：${profileSummary.topFunctions[0].function} (${profileSummary.topFunctions[0].shortUrl}) ${profileSummary.topFunctions[0].selfMs}ms`);
    if (profileSummary.byModule[0])
      notes.push(`最烧 CPU 的模块：${profileSummary.byModule[0].module} ${profileSummary.byModule[0].selfMs}ms`);
  } else if (profileError) notes.push(`CPU 剖析不可用：${profileError}`);
  if (result.clientBundles && result.clientBundles.biggest)
    notes.push(`客户端 bundle 最大包：${result.clientBundles.biggest.name} ${result.clientBundles.biggest.MiB}MiB；总量 ${result.clientBundles.grandTotalMiB}MiB（内嵌图片占 ${result.clientBundles.embeddedImagePercent}%）`);
  if (result.clientBundles && result.clientBundles.findings.length)
    for (const f of result.clientBundles.findings) notes.push('发现：' + f);
  if (fsDelta.length) notes.push(`fs 最重：` + fsDelta.slice(0, 3).map((r) => `${r.op} ${r.count}次/${r.ms}ms`).join('、'));
  notes.push(`窗口 CPU ${result.cpu.cpuPercent}%（user ${result.cpu.userSeconds}s / sys ${result.cpu.systemSeconds}s）`);
  if (result.cpu.systemSeconds > result.cpu.userSeconds * 2 && result.cpu.systemSeconds > 0.5)
    notes.push('系统调用时间显著高于用户态：大量 fs/syscall（proot 穿透的典型特征）');
  result.notes = notes;

  return result;
}

export function startLagSampler(ctx) {
  try {
    try {
      fsModule = cjsRequire('node:fs');
      patchFs();
    } catch {}
    startLagProbe(20, pushLag);

    let lastNonce = '', busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      let request = null;
      try {
        if (!existsSync(REQUEST)) return;
        request = JSON.parse(readFileSync(REQUEST, 'utf8'));
      } catch { return; }
      if (!request || typeof request.nonce !== 'string' || request.nonce === lastNonce) return;
      lastNonce = request.nonce;
      busy = true;
      const seconds = Math.max(5, Math.min(300, Number(request.seconds) || 30));
      measure(seconds, { nonce: request.nonce })
        .then((result) => {
          try {
            writeFileSync(RESULT_TMP, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
            renameSync(RESULT_TMP, RESULT);
          } catch {}
          try { unlinkSync(REQUEST); } catch {}
        })
        .catch(() => {})
        .finally(() => { busy = false; });
    }, POLL_MS);
    if (timer.unref) timer.unref();
    ctx?.effect?.(() => () => { clearInterval(timer); }, 'dsha-lag-sampler');
  } catch {}
}
