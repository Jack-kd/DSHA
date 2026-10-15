package com.deepseekharness.app.core;

import android.content.Context;
import com.deepseekharness.app.util.SensitiveData;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 卡顿诊断：采集「Web 为什么卡」的完整证据链并导出。
 *
 * <p>卡顿点可能隐藏在多处，因此本采集器不预设结论，分层取证：
 *
 * <ol>
 *   <li><b>宿主侧</b>：Web 进程 CPU/内存/线程/上下文切换/IO、进程身份、端口、启动代数
 *   <li><b>容器侧</b>：guest 探针（lag-probe.cjs）在 proot 内测量事件循环延迟、fs 调用分布、
 *       定时器抖动、运行时快照、插件加载、rootfs 穿透延迟
 *   <li><b>HTTP 侧</b>：对 Web 端口做延迟时间线采样，暴露周期性尖峰
 *   <li><b>配置侧</b>：profile/环境变量/补丁应用状态（判断修复是否真的生效）
 * </ol>
 *
 * <p>输出为结构化文本（便于人工分析）+ 原始 JSON（便于比对）。所有内容经过
 * {@link SensitiveData#redact} 脱敏。
 */
public final class LagDiagnostics {
  private LagDiagnostics() {}

  /** 采集结果：可导出文本 + 原始探针 JSON。 */
  public record Snapshot(String text, String rawJson, boolean probeRan, String probeNote) {}

  /** 宿主写请求、dsh 进程内采样器读取（相对 rootfs 的路径）。 */
  private static final String REQUEST_PATH = "root/.dsha-lag-request.json";
  /** 采样器写结果（相对 rootfs 的路径）。 */
  private static final String RESULT_PATH = "root/.dsha-lag-result.json";
  /** 采样器模块（由 app-integration 插件在 dsh 进程内启动）。 */
  private static final String SAMPLER_PATH = "root/dsha-app-integration/lag-sampler.js";
  /** 等待结果的轮询上限（秒数 + 余量）。 */
  private static final long RESULT_WAIT_MARGIN_MS = 20_000;

  /**
   * 运行完整采集。
   *
   * @param seconds guest 探针采样秒数（建议 20–60；过短抓不到周期性尖峰）
   */
  public static Snapshot collect(Context context, int seconds) throws Exception {
    Context app = context.getApplicationContext();
    HarnessController controller = HarnessController.get(app);
    int port = controller.getWebPort();
    long generation = 0;
    try {
      generation = controller.getWebGeneration();
    } catch (Exception ignored) {
      // 代数读不到不影响采集，只是身份里留空。
    }

    List<String> lines = new ArrayList<>();
    lines.add("DSHA 卡顿诊断 / DSHA lag diagnostics");
    lines.add("生成时间: "
        + new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.ROOT)
            .format(new java.util.Date()));
    lines.add("");

    // ── 1. 宿主侧 Web 进程 ──
    lines.add("=== 1. Web 进程（宿主侧视角） ===");
    lines.add("webPort=" + port + " generation=" + generation);
    lines.add("isWebRunning=" + controller.isWebRunning() + " hasLiveWebProcesses="
        + controller.hasLiveWebProcesses());
    lines.add("authFailure=" + safe(controller.getWebAuthFailure()));
    lines.add("lastStopError=" + safe(controller.lastStopError()));
    lines.add("");
    lines.add(hostProcessTable(app, port));
    lines.add("");

    // ── 2. 容器侧探针 ──
    lines.add("=== 2. 容器内探针（guest 侧） ===");
    Snapshot probe = runProbe(app, controller, seconds);
    lines.add("probeRan=" + probe.probeRan());
    lines.add("probeNote=" + probe.probeNote());
    if (probe.rawJson() != null && !probe.rawJson().isEmpty()) {
      lines.add("");
      lines.add(probe.rawJson());
    } else {
      lines.add("");
      lines.add("（探针未运行或无输出；以下为宿主侧可得信息）");
      lines.add(fallbackGuestInfo(app));
    }
    lines.add("");

    // ── 3. 配置与环境 ──
    lines.add("=== 3. 配置与补丁状态 ===");
    lines.add(configSummary(app));
    lines.add("");
    lines.add("=== 4. 复现步骤（用户填写） ===");

    String text = SensitiveData.redact(String.join("\n", lines));
    return new Snapshot(text, probe.rawJson(), probe.probeRan(), probe.probeNote());
  }

  private static String safe(String value) {
    return value == null ? "(none)" : value;
  }

  /** 宿主能直接读到的 Web 进程 /proc 信息（不依赖 guest 探针）。 */
  private static String hostProcessTable(Context context, int port) {
    StringBuilder out = new StringBuilder();
    File proc = new File("/proc");
    String[] entries = proc.list();
    if (entries == null) return "（无法列出 /proc）";
    int seen = 0;
    for (String name : entries) {
      if (!name.matches("[0-9]+")) continue;
      try {
        String cmd = readSmall(new File("/proc/" + name + "/cmdline"), 512)
            .replace('\0', ' ').trim();
        if (cmd.isEmpty()) continue;
        if (!cmd.contains("dsh") && !cmd.contains("node")) continue;
        if (cmd.contains("proot") && !cmd.contains("node")) continue;
        seen++;
        out.append("- pid=").append(name).append(" cmd=").append(cmd).append('\n');
        File status = new File("/proc/" + name + "/status");
        String st = readSmall(status, 8192);
        for (String key :
            new String[] {"Threads:", "VmRSS:", "VmSize:", "voluntary_ctxt_switches:",
                "nonvoluntary_ctxt_switches:", "RssAnon:"}) {
          for (String line : st.split("\\R"))
            if (line.startsWith(key)) { out.append("    ").append(line.trim()).append('\n'); break; }
        }
        String stat = readSmall(new File("/proc/" + name + "/stat"), 4096);
        int close = stat.lastIndexOf(')');
        if (close > 0) {
          String[] f = stat.substring(close + 2).trim().split("\\s+");
          if (f.length > 21)
            out.append("    utime=").append(f[11]).append(" stime=").append(f[12])
                .append(" threads=").append(f[17]).append(" rssPages=").append(f[21]).append('\n');
        }
        File io = new File("/proc/" + name + "/io");
        if (io.isFile()) {
          String iot = readSmall(io, 4096);
          for (String line : iot.split("\\R"))
            if (line.startsWith("syscr:") || line.startsWith("syscw:")
                || line.startsWith("read_bytes:") || line.startsWith("write_bytes:"))
              out.append("    ").append(line.trim()).append('\n');
        }
        File fdDir = new File("/proc/" + name + "/fd");
        String[] fds = fdDir.list();
        out.append("    openFds=").append(fds == null ? "?" : String.valueOf(fds.length)).append('\n');
      } catch (Exception ignored) {
        // /proc 条目随时可能消失；跳过即可。
      }
    }
    if (seen == 0) out.append("（未找到 dsh/node 进程；Web 可能未运行）\n");
    return out.toString();
  }

  private static String readSmall(File file, int limit) {
    try (java.io.InputStream in = new java.io.FileInputStream(file)) {
      byte[] buffer = new byte[limit];
      int read = in.read(buffer);
      if (read <= 0) return "";
      return new String(buffer, 0, read, StandardCharsets.UTF_8);
    } catch (Exception error) {
      return "";
    }
  }

  /**
   * 通过「请求文件 → dsh 进程内采样器采集 → 结果文件」协议取回数据。
   *
   * <p>不能用外部进程：卡顿是 dsh 自己的事件循环被阻塞，外部进程测不到。
   * 因此采样器作为 app-integration 插件挂在 dsh 进程内，宿主只负责写请求、
   * 等结果、读结果。
   */
  private static Snapshot runProbe(Context app, HarnessController controller, int seconds) {
    try {
      var proot = controller.proot();
      if (!proot.isEnvironmentReady()) return new Snapshot("", "", false, "环境未就绪，无法采集");
      File rootfs = proot.getRootfsDir();
      File sampler = new File(rootfs, SAMPLER_PATH);
      if (!sampler.isFile())
        return new Snapshot("", "", false,
            "进程内采样器缺失（" + SAMPLER_PATH + "）；需重新安装受管资产并重启 Web");
      if (!controller.isWebRunning())
        return new Snapshot("", "", false, "Web 未运行：请先启动 DSHA，卡顿采样需要在运行中的 Web 进程内进行");

      int secs = Math.max(5, Math.min(300, seconds));
      String nonce = Long.toHexString(System.nanoTime()) + "-" + Long.toHexString(System.currentTimeMillis());
      File request = new File(rootfs, REQUEST_PATH);
      File result = new File(rootfs, RESULT_PATH);

      // 清掉旧结果，避免读到上一次的数据
      try { result.delete(); } catch (Exception ignored) {}
      String payload = "{\"nonce\":\"" + nonce + "\",\"seconds\":" + secs + "}\n";
      try (java.io.OutputStream out = new java.io.FileOutputStream(request)) {
        out.write(payload.getBytes(StandardCharsets.UTF_8));
      }

      long deadline = System.currentTimeMillis() + secs * 1000L + RESULT_WAIT_MARGIN_MS;
      String json = "";
      while (System.currentTimeMillis() < deadline) {
        if (result.isFile()) {
          try {
            byte[] bytes = java.nio.file.Files.readAllBytes(result.toPath());
            String text = new String(bytes, StandardCharsets.UTF_8);
            // 确认是我们这次请求的结果（采样器写回 nonce）
            if (text.contains("\"" + nonce + "\"")) { json = text; break; }
          } catch (Exception ignored) {
            // 文件可能正在原子替换，稍后重试。
          }
        }
        try { Thread.sleep(500); } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          return new Snapshot("", "", false, "等待采集结果被中断");
        }
      }
      try { request.delete(); } catch (Exception ignored) {}

      if (json.isEmpty())
        return new Snapshot("", "", false,
            "等待 " + secs + " 秒未取到结果。可能原因：采样器未随本次 Web 启动加载（需重启 Web），"
                + "或 Web 进程未在运行。");
      return new Snapshot("", SensitiveData.redact(json), true,
          "进程内采样 " + secs + " 秒；原始 JSON " + json.length() + " 字节");
    } catch (Exception error) {
      return new Snapshot("", "", false,
          "采集失败：" + SensitiveData.redact(String.valueOf(error.getMessage())));
    }
  }

  /** 探针不可用时的降级信息（至少给出端口可达性与进程状态）。 */
  private static String fallbackGuestInfo(Context app) {
    StringBuilder out = new StringBuilder();
    try {
      var controller = HarnessController.get(app);
      int port = controller.getWebPort();
      out.append("webPort=").append(port).append(" webRunning=")
          .append(controller.isWebRunning()).append('\n');
    } catch (Exception error) {
      out.append("获取 Web 状态失败: ").append(safe(error.getMessage())).append('\n');
    }
    return out.toString();
  }

  private static String configSummary(Context app) {
    StringBuilder out = new StringBuilder();
    try {
      File rootfs = HarnessController.get(app).proot().getRootfsDir();
      // 关键：client-hmr 的轮询间隔与 profile 覆盖（判断修复是否真的生效）
      File hmr = new File(rootfs,
          "usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js");
      out.append("client-hmr 模块: ").append(hmr.isFile() ? "存在" : "缺失").append('\n');
      if (hmr.isFile()) {
        String src = readSmall(hmr, 64 * 1024);
        java.util.regex.Matcher m =
            java.util.regex.Pattern.compile("pollIntervalMs:[^;]*?default\\((\\d+)\\)").matcher(src);
        out.append("  default pollIntervalMs=").append(m.find() ? m.group(1) : "?").append('\n');
        out.append("  DSHA 补丁标记存在=")
            .append(src.contains("DSHA_HMR_POLL_INTERVAL_V1")).append('\n');
        out.append("  模块字节数=").append(src.length()).append('\n');
      }
      File patch = new File(rootfs, "root/.dsh/profiles/web/cordis.patch.yml");
      if (patch.isFile()) {
        String text = readSmall(patch, 64 * 1024);
        out.append("cordis.patch.yml: 字节=").append(text.length())
            .append(" 含 client-hmr 覆盖=").append(text.contains("id: client-hmr")).append('\n');
        java.util.regex.Matcher m =
            java.util.regex.Pattern.compile("pollIntervalMs:\\s*(\\d+)").matcher(text);
        out.append("  profile 里 pollIntervalMs=").append(m.find() ? m.group(1) : "无").append('\n');
      }
      // 受管资产版本与运行时身份
      File desc = new File(rootfs, "linux/.runtime-descriptor.json");
      if (desc.isFile()) out.append("runtime-descriptor 存在=").append(desc.length()).append("字节\n");
      // 关键环境变量
      out.append("DSH_HOME=/root/.dsh (固定)\n");
    } catch (Exception error) {
      out.append("配置读取失败: ").append(safe(error.getMessage())).append('\n');
    }
    return out.toString();
  }
}
