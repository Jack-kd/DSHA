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
/** 采集状态广播：宿主据此显示「采集中…」并判断是否已开始。 */
const STATE = '/root/.dsha-lag-state.json';
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

/**
 * 常驻环缓冲：不停记录最近约 2 分钟（6000 样本 × 20ms）的事件循环延迟。
 *
 * 为什么带时间戳：用户的卡顿可能「采集前就发生了」（例如点了采集但工作区要加载
 * 90 秒，采样窗口结束时卡顿还没跑完；或者先卡完才想起点采集）。带时间戳后，
 * 报告可以把「采集前」的历史一并还原成时间线，仍能定位到那次长卡顿。
 */
const ring = { lag: [], stamps: [], capacity: 6000 };
const pushLag = (v) => {
  ring.lag.push(v);
  ring.stamps.push(Date.now());
  if (ring.lag.length > ring.capacity) { ring.lag.shift(); ring.stamps.shift(); }
};
/** 把环缓冲还原成 {at, ms} 时间线（供报告展示「采集前」的卡顿）。 */
function ringTimeline(limit) {
  const out = [];
  const start = Math.max(0, ring.lag.length - (limit || ring.lag.length));
  for (let i = start; i < ring.lag.length; i++) out.push({ ms: +ring.lag[i].toFixed(1), at: new Date(ring.stamps[i]).toISOString() });
  return out;
}
/** 环缓冲里的显著卡顿（用于回答「采集前发生的卡顿」）。 */
function ringSpikes(thresholdMs) {
  const out = [];
  for (let i = 0; i < ring.lag.length; i++)
    if (ring.lag[i] > thresholdMs) out.push({ ms: +ring.lag[i].toFixed(1), at: new Date(ring.stamps[i]).toISOString() });
  return out.slice(-40);
}

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
 * 背景：dsh 把每个客户端插件编成独立的 client.js，由 HTTP 逐个提供且不做压缩。
 * 本函数只做【客观测量】——列出各包体积、内嵌 base64 图片占比等，供与
 * eventLoop / cpuProfile 的结论交叉验证；不预设某一项就是卡顿主因。
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

  // 这些只是【客观测量】，不预设它们是卡顿主因；需与 eventLoop/cpuProfile 联合判断。
  if (out.bundles[0] && out.bundles[0].embeddedImageBytes > 1048576)
    out.findings.push(`最大包 ${out.bundles[0].name} 含 ${(out.bundles[0].embeddedImageBytes/1048576).toFixed(2)}MB 内嵌 base64 图片（体积事实）`);
  if (out.embeddedImagePercent > 20)
    out.findings.push(`内嵌 base64 图片占客户端 bundle 总量的 ${out.embeddedImagePercent}%（体积构成事实）`);
  if (out.totals[roots[0]] && out.totals[roots[0]].totalMiB > 8)
    out.findings.push(`客户端 bundle 合计 ${out.totals[roots[0]].totalMiB}MiB（服务端未压缩传输，serveBundle 无 gzip/br）`);
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

/** 合并两个剖析摘要（用于把「常驻段」与「会话段」拼成完整覆盖）。 */
function mergeProfileSummaries(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const fnKey = (f) => f.function + '|' + f.shortUrl + '|' + f.line;
  const byFn = new Map();
  for (const src of [a, b])
    for (const f of (src.topFunctions || [])) {
      const k = fnKey(f);
      const cur = byFn.get(k) || { ...f };
      cur.selfMs = +(cur.selfMs + f.selfMs).toFixed(1);
      byFn.set(k, cur);
    }
  const byMod = new Map();
  for (const src of [a, b])
    for (const m of (src.byModule || [])) {
      const cur = byMod.get(m.module) || { module: m.module, selfMs: 0, functions: 0 };
      cur.selfMs = +(cur.selfMs + m.selfMs).toFixed(1);
      cur.functions += m.functions || 0;
      byMod.set(m.module, cur);
    }
  return {
    coveredSeconds: +(((a.coveredSeconds || 0) + (b.coveredSeconds || 0))).toFixed(0),
    totalSelfMs: +((a.totalSelfMs || 0) + (b.totalSelfMs || 0)).toFixed(1),
    idleSelfMs: +((a.idleSelfMs || 0) + (b.idleSelfMs || 0)).toFixed(1),
    gcSelfMs: +((a.gcSelfMs || 0) + (b.gcSelfMs || 0)).toFixed(1),
    sampleCount: (a.sampleCount || 0) + (b.sampleCount || 0),
    topFunctions: [...byFn.values()].sort((x, y) => y.selfMs - x.selfMs).slice(0, 40),
    byModule: [...byMod.values()].map((r) => ({ ...r, selfMs: +r.selfMs.toFixed(1) }))
      .sort((x, y) => y.selfMs - x.selfMs).slice(0, 30),
  };
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

/**
 * 采集会话：start() 开始积累，stop() 结束并产出结果。
 *
 * 为什么改成 start/stop：用户的实际流程是「点采集 → 去工作台复现卡顿（可能加载很久）
 * → 回来后手动停止」。固定窗口（如 30 秒）会在卡顿还没结束时提前收尾，抓不到完整过程。
 * start/stop 让窗口长度由用户决定。
 */
/**
 * 常驻 CPU 剖析器 —— 这是抓到「采集之前」那次长阻塞的关键。
 *
 * <p>为什么必须常驻：用户是先经历卡顿、才想起点采集（或用固定窗口时卡顿在窗口外）。
 * 只在会话内剖析的话，那段阻塞完全不会被归因（实测正是如此：76 秒阻塞发生在
 * 采集窗口之前，会话剖析里只有 3 个样本）。V8 的采样在独立线程上进行，因此即使
 * 主线程被同步 I/O 阻塞，也能采到造成阻塞的那个函数。
 *
 * <p>内存有界：定期（默认 90 秒）停止并结算成摘要，再重新开始，只保留最近若干段的
 * 合并摘要。
 */
const resident = { session: null, startedAt: 0, intervalMs: 3000, summaries: [], rotating: false, timer: null };

async function residentStart() {
  try {
    const { Session } = cjsRequire('node:inspector');
    const session = new Session();
    session.connect();
    await new Promise((res, rej) => session.post('Profiler.enable', {}, (e) => e ? rej(e) : res()));
    await new Promise((res, rej) => session.post('Profiler.setSamplingInterval', { interval: resident.intervalMs }, (e) => e ? rej(e) : res()));
    await new Promise((res, rej) => session.post('Profiler.start', {}, (e) => e ? rej(e) : res()));
    resident.session = session;
    resident.startedAt = Date.now();
  } catch { resident.session = null; }
}

async function residentRotate(keepLatest) {
  if (!resident.session || resident.rotating) return;
  resident.rotating = true;
  const session = resident.session;
  resident.session = null;
  try {
    const { profile } = await new Promise((res, rej) => session.post('Profiler.stop', {}, (e, r) => e ? rej(e) : res(r)));
    const summary = summarizeProfile(profile);
    summary.coveredSeconds = +((Date.now() - resident.startedAt) / 1000).toFixed(0);
    resident.summaries.push(summary);
    // 只保留最近 3 段（约 4.5 分钟），内存有界。
    while (resident.summaries.length > 3) resident.summaries.shift();
    try { session.disconnect(); } catch {}
  } catch {}
  resident.rotating = false;
  if (keepLatest !== false) await residentStart();
}

/**
 * 常驻剖析摘要（合并最近若干段），覆盖会话之前的时间。
 *
 * <p>注意：进行中的那一段必须现场结算（stop→摘要→立刻重新 start），否则短时间内
 * 采集时 summaries 还是空的（轮换要等 90 秒）。结算会造成一次极短的剖析空档，
 * 可接受（相比拿不到采集前的归因，这点损失值得）。
 */
async function residentSummaryAsync() {
  if (resident.session) {
    await residentRotate(true);   // 结算当前段并立即重开
  }
  if (!resident.summaries.length) return null;
  return resident.summaries.reduce((acc, cur) => mergeProfileSummaries(acc, cur), null);
}

function beginSession(context) {
  const samples = [], worst = [];
  const startedAt = Date.now();
  const windowStartIso = new Date(startedAt).toISOString();
  const probe = startLagProbe(20, (lag) => {
    samples.push(lag);
    if (worst.length < 20 || lag > worst[worst.length - 1].ms) {
      worst.push({ ms: +lag.toFixed(1), at: new Date().toISOString(), sinceStartMs: Date.now() - startedAt });
      worst.sort((a, b) => b.ms - a.ms);
      if (worst.length > 20) worst.length = 20;
    }
  });
  const fsBefore = new Map();
  for (const [k, v] of fsCounters) fsBefore.set(k, v.count);
  const before = procSelf('atStart');

  // CPU 剖析：整个会话
  let session = null, profileError = '';
  let beginning = (async () => {
    try {
      const { Session } = cjsRequire('node:inspector');
      session = new Session();
      session.connect();
      await new Promise((res, rej) => session.post('Profiler.enable', {}, (e) => e ? rej(e) : res()));
      await new Promise((res, rej) => session.post('Profiler.setSamplingInterval', { interval: 1000 }, (e) => e ? rej(e) : res()));
      await new Promise((res, rej) => session.post('Profiler.start', {}, (e) => e ? rej(e) : res()));
    } catch (error) { profileError = String((error && error.message) || error); session = null; }
  })();

  return {
    startedAt, windowStartIso,
    /** 当前已采多少秒（宿主可显示进度） */
    elapsedSeconds() { return Math.round((Date.now() - startedAt) / 1000); },
    /** 结束采集，返回完整结果对象。 */
    async finish(extra) {
      await beginning;
      let profileSummary = null;
      try {
        if (session) {
          const { profile } = await new Promise((res, rej) =>
            session.post('Profiler.stop', {}, (e, r) => e ? rej(e) : res(r)));
          profileSummary = summarizeProfile(profile);
          try { session.disconnect(); } catch {}
        }
      } catch (error) { profileError = String((error && error.message) || error); }
      probe.stop();
      return await buildResult({ samples, worst, windowStartIso, startedAt, fsBefore, before, profileSummary, profileError, context, extra });
    },
  };
}

/** 把一次会话的原始数据整理成可序列化结果。 */
async function buildResult({ samples, worst, windowStartIso, startedAt, fsBefore, before, profileSummary, profileError, context, extra }) {
  const after = procSelf('atEnd');
  const sorted = samples.slice().sort((a, b) => a - b);
  const fsDelta = [];
  for (const [op, row] of fsCounters) {
    const was = fsBefore.get(op) || 0;
    if (row.count - was > 0) fsDelta.push({ op, count: row.count - was, ms: +row.ms.toFixed(1) });
  }
  fsDelta.sort((a, b) => b.ms - a.ms);
  const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const dU = ((after.utimeJiffies || 0) - (before.utimeJiffies || 0)) / 100;
  const dS = ((after.stimeJiffies || 0) - (before.stimeJiffies || 0)) / 100;

  const result = {
    schema: 3,
    kind: 'dsha-lag-sampler',
    nonce: context.nonce,
    mode: 'manual-start-stop',
    generatedAt: new Date().toISOString(),
    durationSeconds: secs,
    note: (extra && extra.note) || '手动开始/停止采集；时长由用户决定。',
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
      windowStart: windowStartIso,
      windowEnd: new Date().toISOString(),
      sinceStart: { samples: ring.lag.length, summary: quantiles(ring.lag.slice().sort((a, b) => a - b)) },
    },
    preWindow: {
      note: '常驻环缓冲记录最近约 2 分钟；用于捕捉「点采集之前」或「采样窗口结束后」仍在发生的卡顿。',
      spanSeconds: +((ring.lag.length * 20) / 1000).toFixed(0),
      summary: quantiles(ring.lag.slice().sort((a, b) => a - b)),
      significantSpikes: ringSpikes(100),
      timeline: ringTimeline(2000),
    },
    cpuProfile: profileSummary,
    cpuProfileError: profileError || null,
    // 常驻剖析：覆盖「采集窗口之前」的时间（关键：用户往往先经历卡顿、才点采集，
    // 那段阻塞只可能在这里被归因）。
    residentProfile: await residentSummaryAsync(),
    residentProfileNote: '常驻 CPU 剖析，定期轮换、只保留最近约 4.5 分钟；用于归因采集窗口之前发生的卡顿。',
    fs: { byOperation: fsDelta },
    clientBundles: analyzeClientBundles(),
    proc: { before, after },
    cpu: { windowSeconds: secs, userSeconds: +dU.toFixed(2), systemSeconds: +dS.toFixed(2),
           cpuPercent: +(((dU + dS) / secs) * 100).toFixed(2) },
  };

  const notes = [];
  notes.push(`手动采集 ${secs} 秒：事件循环 P50=${result.eventLoop.p50}ms P90=${result.eventLoop.p90}ms P99=${result.eventLoop.p99}ms max=${result.eventLoop.max}ms`);
  if (result.eventLoop.over100ms) notes.push(`${result.eventLoop.over100ms} 次 >100ms 阻塞；最差 ${result.eventLoop.max}ms @ ${result.eventLoop.worst[0] ? result.eventLoop.worst[0].at : '?'}`);
  if (profileSummary) {
    notes.push(`CPU 剖析：总自耗时 ${profileSummary.totalSelfMs}ms（采样 ${profileSummary.sampleCount} 次）`);
    if (profileSummary.gcSelfMs > 0) notes.push(`GC 自耗时 ${profileSummary.gcSelfMs}ms`);
    if (profileSummary.topFunctions[0])
      notes.push(`最烧 CPU 的函数：${profileSummary.topFunctions[0].function} (${profileSummary.topFunctions[0].shortUrl}) ${profileSummary.topFunctions[0].selfMs}ms`);
    if (profileSummary.byModule[0])
      notes.push(`最烧 CPU 的模块：${profileSummary.byModule[0].module} ${profileSummary.byModule[0].selfMs}ms`);
  } else if (profileError) notes.push(`CPU 剖析不可用：${profileError}`);
  const rp = result.residentProfile;
  if (rp && rp.topFunctions && rp.topFunctions.length) {
    notes.push(`常驻剖析（覆盖约 ${rp.coveredSeconds}s，含采集之前）：最烧 CPU 的模块 ${rp.byModule && rp.byModule[0] ? rp.byModule[0].module : '?'} / 函数 ${rp.topFunctions[0].function}（${rp.topFunctions[0].selfMs}ms）`);
    const syncSuspects = rp.topFunctions.filter((f) => /stat|read|open|realpath|Sync|walk|scan/i.test(f.function));
    if (syncSuspects.length)
      notes.push('常驻剖析中与同步 I/O 相关的热点：' + syncSuspects.slice(0, 5).map((f) => `${f.function}(${f.selfMs}ms)`).join('、'));
  }
  if (result.clientBundles && result.clientBundles.biggest)
    notes.push(`[体积事实] 客户端 bundle 最大包：${result.clientBundles.biggest.name} ${result.clientBundles.biggest.MiB}MiB；总量 ${result.clientBundles.grandTotalMiB}MiB（内嵌图片占 ${result.clientBundles.embeddedImagePercent}%）`);
  if (result.clientBundles && result.clientBundles.findings.length)
    for (const f of result.clientBundles.findings) notes.push('[体积事实] ' + f);
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
    // 常驻轻量探测：始终记录最近约 2 分钟的延迟，供 preWindow 历史使用。
    startLagProbe(20, pushLag);
    // 常驻 CPU 剖析：长期运行、定期轮换，使「采集之前」的阻塞也能被归因。
    residentStart().catch(() => {});
    const rotate = setInterval(() => { residentRotate(true).catch(() => {}); }, 90 * 1000);
    if (rotate.unref) rotate.unref();
    ctx?.effect?.(() => () => { clearInterval(rotate); residentRotate(false).catch(() => {}); }, 'dsha-lag-resident');

    let lastStartNonce = '';
    let active = null;   // 正在进行的采集会话
    const writeState = (value) => {
      try {
        writeFileSync(STATE + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        renameSync(STATE + '.tmp', STATE);
      } catch {}
    };

    const timer = setInterval(() => {
      let request = null;
      try {
        if (!existsSync(REQUEST)) return;
        request = JSON.parse(readFileSync(REQUEST, 'utf8'));
      } catch { return; }
      if (!request || typeof request.nonce !== 'string') return;
      const action = String(request.action || 'start');

      if (action === 'start') {
        if (request.nonce === lastStartNonce) return;
        lastStartNonce = request.nonce;
        // 已有会话在跑：先收尾再开新的，避免丢数据。
        if (active) { try { active.finish({ note: '前一次采集被新请求取代' }); } catch {} }
        try { unlinkSync(RESULT); } catch {}
        active = beginSession({ nonce: request.nonce });
        writeState({ nonce: request.nonce, phase: 'collecting', startedAt: new Date().toISOString() });
        try { unlinkSync(REQUEST); } catch {}
        return;
      }

      if (action === 'stop') {
        if (!active) {
          writeState({ nonce: request.nonce, phase: 'idle', note: '没有正在进行的采集' });
          try { unlinkSync(REQUEST); } catch {}
          return;
        }
        const session = active;
        active = null;
        writeState({ nonce: request.nonce, phase: 'finishing', startedAt: new Date(session.startedAt).toISOString() });
        session.finish({ note: '用户手动停止采集' })
          .then((result) => {
            try {
              writeFileSync(RESULT_TMP, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
              renameSync(RESULT_TMP, RESULT);
            } catch {}
            writeState({ nonce: request.nonce, phase: 'done', seconds: result.durationSeconds,
                         startedAt: new Date(session.startedAt).toISOString(), finishedAt: new Date().toISOString() });
            try { unlinkSync(REQUEST); } catch {}
          })
          .catch(() => {
            writeState({ nonce: request.nonce, phase: 'failed' });
            try { unlinkSync(REQUEST); } catch {}
          });
        return;
      }
    }, POLL_MS);
    if (timer.unref) timer.unref();
    ctx?.effect?.(() => () => { clearInterval(timer); }, 'dsha-lag-sampler');
  } catch {}
}
