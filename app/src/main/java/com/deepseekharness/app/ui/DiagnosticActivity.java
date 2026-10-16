package com.deepseekharness.app.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.os.Bundle;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.lifecycle.ViewModelProvider;
import com.deepseekharness.app.R;
import com.deepseekharness.app.core.DiagnosticRepository;
import com.deepseekharness.app.util.SensitiveData;

public final class DiagnosticActivity extends AppCompatActivity {
  private DiagnosticRepository repository;
  private com.deepseekharness.app.core.ErrorLogRepository logs;
  private EditText steps;

  public static android.content.Intent downloadLogs(android.content.Context context) {
    return new android.content.Intent(context, DiagnosticActivity.class)
        .putExtra("download_error_logs", true);
  }

  private final ActivityResultLauncher<String> logExporter =
      registerForActivityResult(
          new ActivityResultContracts.CreateDocument("text/plain"),
          uri -> {
            if (uri != null) logs.export(uri);
          });
  /** 卡顿诊断导出：内容由 LagDiagnostics 采集，此处只负责落盘。 */
  private String pendingLagReport;
  private final ActivityResultLauncher<String> lagExporter =
      registerForActivityResult(
          new ActivityResultContracts.CreateDocument("text/plain"),
          uri -> {
            if (uri == null) return;
            final String report = pendingLagReport;
            if (report == null) return;
            new Thread(
                    () -> {
                      String message;
                      try (java.io.OutputStream stream =
                          getContentResolver().openOutputStream(uri, "wt")) {
                        if (stream == null)
                          throw new java.io.IOException(
                              com.deepseekharness.app.util.UiText.text("无法写入所选位置"));
                        stream.write(report.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        message = com.deepseekharness.app.util.UiText.text("卡顿诊断已保存");
                      } catch (Exception error) {
                        message =
                            com.deepseekharness.app.util.UiText.format(
                                "导出失败：%s", error.getClass().getSimpleName());
                      }
                      pendingLagReport = null;
                      String done = message;
                      runOnUiThread(
                          () ->
                              Toast.makeText(getApplicationContext(), done, Toast.LENGTH_LONG)
                                  .show());
                    },
                    "lag-export")
                .start();
          });

  private final ActivityResultLauncher<String> exporter =
      registerForActivityResult(
          new ActivityResultContracts.CreateDocument("text/plain"),
          uri -> {
            if (uri == null) return;
            final String report = completeReport();
            new Thread(
                    () -> {
                      String message;
                      try (java.io.OutputStream stream =
                          getContentResolver().openOutputStream(uri, "wt")) {
                        if (stream == null)
                          throw new java.io.IOException(
                              com.deepseekharness.app.util.UiText.text("无法写入所选位置"));
                        stream.write(report.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        message = com.deepseekharness.app.util.UiText.text("诊断报告已导出");
                      } catch (Exception error) {
                        message =
                            com.deepseekharness.app.util.UiText.format(
                                "导出失败：%s", error.getClass().getSimpleName());
                      }
                      String done = message;
                      runOnUiThread(
                          () ->
                              Toast.makeText(getApplicationContext(), done, Toast.LENGTH_LONG)
                                  .show());
                    },
                    "diagnostic-export")
                .start();
          });

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    setContentView(R.layout.activity_diagnostics);
    repository = new ViewModelProvider(this).get(DiagnosticRepository.class);
    repository.results.observe(
        this,
        items -> {
          android.widget.LinearLayout rows = findViewById(R.id.diagnostic_results);
          rows.removeAllViews();
          CardPage ui = new CardPage(this, "", "");
          for (var item : items)
            ui.entry(
                rows,
                item.title,
                item.status,
                R.drawable.ic_ui2_box,
                () -> CardSheet.show(this, item.title, item.detail));
        });
    findViewById(R.id.diagnostic_history).setOnClickListener(v -> showHistory());
    findViewById(R.id.diagnostic_recovery)
        .setOnClickListener(
            v -> startActivity(new android.content.Intent(this, StartupRecoveryActivity.class)));
    logs = new ViewModelProvider(this).get(com.deepseekharness.app.core.ErrorLogRepository.class);
    findViewById(R.id.diagnostic_logs_download).setOnClickListener(v -> logs.download());
    findViewById(R.id.diagnostic_logs_save_as)
        .setOnClickListener(
            v -> {
              try {
                logExporter.launch(com.deepseekharness.app.core.ErrorLogRepository.filename());
              } catch (RuntimeException error) {
                Toast.makeText(
                        this,
                        com.deepseekharness.app.util.UiText.text("无法打开文件管理器，请尝试下载到默认目录"),
                        Toast.LENGTH_LONG)
                    .show();
              }
            });
    logs.state.observe(
        this,
        state -> {
          ((TextView) findViewById(R.id.diagnostic_logs_status))
              .setText(com.deepseekharness.app.util.UiStateText.render(state.message));
          findViewById(R.id.diagnostic_logs_download).setEnabled(!state.busy);
          findViewById(R.id.diagnostic_logs_save_as).setEnabled(!state.busy);
          findViewById(R.id.diagnostic_logs_status).setEnabled(!state.busy && state.uri != null);
        });
    findViewById(R.id.diagnostic_logs_status)
        .setOnClickListener(
            v -> {
              com.deepseekharness.app.core.ErrorLogRepository.State state = logs.state.getValue();
              if (state == null || state.uri == null || state.busy) return;
              try {
                android.net.Uri uri = state.uri;
                if ("file".equals(uri.getScheme()))
                  uri =
                      androidx.core.content.FileProvider.getUriForFile(
                          this, getPackageName() + ".updates", new java.io.File(uri.getPath()));
                startActivity(
                    new android.content.Intent(android.content.Intent.ACTION_VIEW)
                        .setDataAndType(uri, "text/plain")
                        .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION));
              } catch (RuntimeException error) {
                Toast.makeText(
                        this,
                        com.deepseekharness.app.util.UiText.text(
                            "无法打开日志，可在文件管理器的 Download/DSHA 中查看，或重新下载"),
                        Toast.LENGTH_LONG)
                    .show();
              }
            });
    steps = findViewById(R.id.diagnostic_steps);
    findViewById(R.id.diagnostic_back).setOnClickListener(v -> finish());
    findViewById(R.id.diagnostic_refresh).setOnClickListener(v -> repository.generate());
    findViewById(R.id.diagnostic_repair).setOnClickListener(v -> repository.repairNetworkTools());
    findViewById(R.id.diagnostic_plugins)
        .setOnClickListener(
            v ->
                startActivity(
                    new android.content.Intent(this, MainActivity.class)
                        .putExtra("open_plugins", true)));
    findViewById(R.id.diagnostic_copy)
        .setOnClickListener(
            v -> {
              try {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (clipboard == null)
                  throw new IllegalStateException(
                      com.deepseekharness.app.util.UiText.text("剪贴板不可用"));
                clipboard.setPrimaryClip(
                    com.deepseekharness.app.bridge.SensitiveClipboard.text(
                        com.deepseekharness.app.util.UiText.text("DSHA 诊断"), completeReport()));
                Toast.makeText(
                        this,
                        com.deepseekharness.app.util.UiText.choose(
                            "报告已复制，请在公开分享前查看内容",
                            "Report copied. Review its content before public sharing"),
                        Toast.LENGTH_SHORT)
                    .show();
              } catch (Exception error) {
                Toast.makeText(
                        this,
                        com.deepseekharness.app.util.UiText.text("复制失败，可尝试导出报告"),
                        Toast.LENGTH_LONG)
                    .show();
              }
            });
    findViewById(R.id.diagnostic_lag).setOnClickListener(v -> captureLag());
    // 状态行可点：把最近一次卡顿结果「另存到自选位置」（自动保存已写入 Download/DSHA/）
    findViewById(R.id.diagnostic_lag_status)
        .setOnClickListener(
            v -> {
              if (pendingLagReport == null || pendingLagReport.isEmpty()) {
                Toast.makeText(
                        this,
                        com.deepseekharness.app.util.UiText.text("还没有采集结果，请先点「采集卡顿诊断」"),
                        Toast.LENGTH_LONG)
                    .show();
                return;
              }
              try {
                lagExporter.launch(
                    "DSHA-lag-"
                        + new java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.ROOT)
                            .format(new java.util.Date())
                        + ".txt");
              } catch (RuntimeException error) {
                Toast.makeText(
                        this,
                        com.deepseekharness.app.util.UiText.text("无法打开保存位置，结果已在 Download/DSHA/"),
                        Toast.LENGTH_LONG)
                    .show();
              }
            });
    findViewById(R.id.diagnostic_export)
        .setOnClickListener(
            v -> {
              try {
                exporter.launch(
                    "DSHA-diagnostic-"
                        + new java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.ROOT)
                            .format(new java.util.Date())
                        + ".txt");
              } catch (RuntimeException error) {
                Toast.makeText(
                        this,
                        com.deepseekharness.app.util.UiText.text("无法打开保存位置，请使用复制报告或检查系统文件管理器"),
                        Toast.LENGTH_LONG)
                    .show();
              }
            });
    repository.report.observe(
        this, text -> ((TextView) findViewById(R.id.diagnostic_report)).setText(text));
    repository.phase.observe(
        this,
        phase -> {
          TextView headline = findViewById(R.id.diagnostic_headline);
          TextView status = findViewById(R.id.diagnostic_status);
          if (phase == DiagnosticRepository.Phase.RUNNING) {
            headline.setText(com.deepseekharness.app.util.UiText.choose("正在检查", "Checking"));
            status.setText(com.deepseekharness.app.util.UiText.text("正在检查环境…"));
          } else if (phase == DiagnosticRepository.Phase.FAILED) {
            headline.setText(
                com.deepseekharness.app.util.UiText.choose("检查未完成", "Check incomplete"));
            status.setText(
                com.deepseekharness.app.util.UiText.choose(
                    "请打开失败卡片查看原因，也可复制或导出脱敏报告。",
                    "Open the failure card for details, or copy or export the redacted report."));
          } else {
            headline.setText(
                phase == DiagnosticRepository.Phase.SUCCEEDED
                    ? com.deepseekharness.app.util.UiText.choose("检查已完成", "Checks completed")
                    : com.deepseekharness.app.util.UiText.choose("准备检查", "Ready to check"));
            status.setText(com.deepseekharness.app.util.UiText.text("报告保留在本机，复制或导出后可用于反馈"));
          }
        });
    repository.busy.observe(
        this,
        busy -> {
          for (int id :
              new int[] {
                R.id.diagnostic_refresh,
                R.id.diagnostic_repair,
                R.id.diagnostic_copy,
                R.id.diagnostic_export,
                R.id.diagnostic_lag
              }) findViewById(id).setEnabled(!busy);
        });
    // 恢复「正在采集」状态：用户点开始后会离开本页去复现卡顿，回来后（可能已重建
    // Activity）按钮必须仍然是「停止采集并保存」，否则会被误当成新的开始。
    try {
      String active = getSharedPreferences(LAG_PREFS, 0).getString("active_nonce", "");
      if (!active.isEmpty()) {
        lagNonce = active;
        // 会话对象只需要 nonce 与 rootfs；从当前环境重建，避免依赖内存字段。
        lagSession =
            com.deepseekharness.app.core.LagDiagnostics.resumeSession(getApplicationContext(), active);
        ((android.widget.Button) findViewById(R.id.diagnostic_lag))
            .setText(com.deepseekharness.app.util.UiText.text("停止采集并保存"));
        ((TextView) findViewById(R.id.diagnostic_lag_status))
            .setText(
                com.deepseekharness.app.util.UiText.text(
                    "采集中…去工作台复现卡顿，回来后点「停止采集并保存」。"));
      }
    } catch (RuntimeException ignored) {
    }
    // 恢复上次卡顿采集的结果提示：用户去工作台复现卡顿后会回到本页，必须能看到结论。
    try {
      var lagPrefs = getSharedPreferences("dsha_lag_exports", 0);
      String lastPath = lagPrefs.getString("last_name", "");
      if (!lastPath.isEmpty()) {
        ((TextView) findViewById(R.id.diagnostic_lag_status))
            .setText("上次采集结果已保存到 Download/DSHA/" + lastPath);
        pendingLagReport = lagPrefs.getString("last_text", null);
      }
    } catch (RuntimeException ignored) {
    }
    if (saved == null) {
      if (getIntent().getBooleanExtra("download_error_logs", false)) logs.download();
      // 首页先展示检查范围，由用户发起耗时探针。
    }
  }

  private void showHistory() {
    new Thread(
            () -> {
              var entries =
                  com.deepseekharness.app.core.HarnessController.get(this)
                      .startupDiagnostics()
                      .history();
              runOnUiThread(
                  () -> {
                    if (isFinishing() || isDestroyed()) return;
                    CardPage page =
                        new CardPage(this, getString(R.string.ui134_recent_startups), "");
                    var dialog = CardSheet.create(this, page);
                    for (var entry : entries) {
                      String date =
                          java.text.DateFormat.getDateTimeInstance()
                              .format(new java.util.Date(entry.started));
                      page.entry(
                          page.content,
                          date,
                          entry.stage + " · " + entry.status,
                          R.drawable.ic_recovery_document,
                          () ->
                              CardSheet.show(
                                  this,
                                  date,
                                  entry.stage + "\n\n" + entry.reason + "\n\n" + entry.log));
                    }
                    if (entries.isEmpty())
                      page.content.addView(
                          page.text(
                              com.deepseekharness.app.util.UiText.choose(
                                  "还没有启动记录。", "No startup records yet."),
                              13,
                              R.color.text_secondary));
                    page.button(
                        page.footer,
                        com.deepseekharness.app.util.UiText.choose("关闭", "Close"),
                        false,
                        dialog::dismiss);
                    CardSheet.show(dialog, this);
                  });
            },
            "diagnostic-history")
        .start();
  }

  /**
   * 卡顿诊断：后台采集（默认 30 秒）→ 完成后弹保存框。
   *
   * <p>采集期间禁用按钮并显示进度；采集在后台线程进行，不阻塞界面。
   * 卡顿点可能隐藏，因此报告含宿主/容器/HTTP/配置四个层面的原始数据。
   */
  /**
   * 卡顿诊断：后台采集（默认 30 秒）→ 完成后**自动保存**到 Download/DSHA/。
   *
   * <p>为什么必须自动保存：用户要复现卡顿就必须离开诊断页（去点设置/选工作区），
   * 而采集完成时人往往不在这个页面上。若沿用「弹保存框」的做法，结果会在页面
   * 销毁时被丢弃（正是用户遇到的「没看到保存界面」）。因此这里改成：采集结论
   * 一出来就立刻写盘并记住路径，回到页面时直接显示「已保存 + 文件位置」。
   *
   * <p>同时保留「另存为」入口（按钮下方状态行可点），供需要自选位置的用户使用。
   */
  /** 当前正在进行的采集会话（null 表示未在采集）。 */
  private com.deepseekharness.app.core.LagDiagnostics.Session lagSession;
  /** 采集会话的 nonce；持久化在 SharedPreferences 里，避免退出界面后会话丢失。 */
  private String lagNonce = "";
  private static final String LAG_PREFS = "dsha_lag_exports";
  /**
   * 卡顿诊断入口：未在采集 → 开始；已在采集 → 停止并保存。
   *
   * <p>采用手动 start/stop：用户可以点开始后离开本页，去工作台复现卡顿（哪怕加载
   * 几分钟），回来后点「停止并保存」，再自己选保存位置。这样窗口长度由用户决定，
   * 不会像固定 30 秒那样在卡顿还没结束时提前收尾。
   */
  private void captureLag() {
    final android.widget.Button button = findViewById(R.id.diagnostic_lag);
    final android.widget.TextView status = findViewById(R.id.diagnostic_lag_status);
    if (lagSession == null) {
      // ── 开始采集 ──
      button.setEnabled(false);
      status.setText(com.deepseekharness.app.util.UiText.text("正在启动采集…"));
      new Thread(
              () -> {
                try {
                  var session = com.deepseekharness.app.core.LagDiagnostics.start(getApplicationContext());
                  lagSession = session;
                  lagNonce = session.nonce();
                  getSharedPreferences(LAG_PREFS, 0).edit()
                      .putString("active_nonce", lagNonce)
                      .putLong("active_started", System.currentTimeMillis())
                      .apply();
                  runOnUiThread(
                      () -> {
                        if (isFinishing() || isDestroyed()) return;
                        button.setEnabled(true);
                        button.setText(com.deepseekharness.app.util.UiText.text("停止采集并保存"));
                        status.setText(
                            com.deepseekharness.app.util.UiText.text(
                                "采集中…现在去工作台复现卡顿（点设置/选工作区），回来后点「停止采集并保存」。"));
                      });
                } catch (Exception error) {
                  final String detail =
                      com.deepseekharness.app.util.SensitiveData.redact(String.valueOf(error.getMessage()));
                  runOnUiThread(
                      () -> {
                        if (isFinishing() || isDestroyed()) return;
                        button.setEnabled(true);
                        button.setText(com.deepseekharness.app.util.UiText.text("采集卡顿诊断"));
                        getSharedPreferences(LAG_PREFS, 0)
                            .edit().remove("active_nonce").remove("active_started").apply();
                        lagSession = null;
                        lagNonce = "";
                        status.setText(
                            com.deepseekharness.app.util.UiText.format("无法开始采集：%s", detail));
                        Toast.makeText(getApplicationContext(), detail, Toast.LENGTH_LONG).show();
                      });
                }
              },
              "lag-start")
          .start();
      return;
    }

    // ── 停止采集并保存 ──
    final var session = lagSession;
    lagSession = null;
    lagNonce = "";
    getSharedPreferences(LAG_PREFS, 0).edit().remove("active_nonce").remove("active_started").apply();
    button.setEnabled(false);
    status.setText(com.deepseekharness.app.util.UiText.text("正在停止采集并整理结果…"));
    new Thread(
            () -> {
              String text;
              String note;
              boolean ok;
              try {
                var snapshot =
                    com.deepseekharness.app.core.LagDiagnostics.stop(getApplicationContext(), session);
                text = snapshot.text();
                note = snapshot.probeNote();
                ok = true;
              } catch (Exception error) {
                ok = false;
                text =
                    com.deepseekharness.app.util.UiText.format(
                        "停止采集失败：%s",
                        com.deepseekharness.app.util.SensitiveData.redact(
                            String.valueOf(error.getMessage())));
                note = "";
              }
              final String report = text;
              final String probeNote = note;
              final boolean collected = ok;
              runOnUiThread(
                  () -> {
                    if (isFinishing() || isDestroyed()) return;
                    button.setEnabled(true);
                    button.setText(com.deepseekharness.app.util.UiText.text("采集卡顿诊断"));
                    if (!collected) {
                      status.setText(com.deepseekharness.app.util.SensitiveData.redact(report));
                      Toast.makeText(
                              getApplicationContext(),
                              com.deepseekharness.app.util.SensitiveData.redact(report),
                              Toast.LENGTH_LONG)
                          .show();
                      return;
                    }
                    pendingLagReport = report;
                    status.setText(
                        com.deepseekharness.app.util.UiText.format(
                            "采集完成（%s）。请选择保存位置。", probeNote));
                    // 弹系统保存框，由用户自己选路径（不再自动写 Download/DSHA）。
                    try {
                      lagExporter.launch(
                          "DSHA-lag-"
                              + new java.text.SimpleDateFormat(
                                      "yyyyMMdd-HHmmss", java.util.Locale.ROOT)
                                  .format(new java.util.Date())
                              + ".txt");
                    } catch (RuntimeException error) {
                      Toast.makeText(
                              getApplicationContext(),
                              com.deepseekharness.app.util.UiText.text(
                                  "无法打开保存位置，可先复制诊断报告"),
                              Toast.LENGTH_LONG)
                          .show();
                    }
                  });
            },
            "lag-stop")
        .start();
  }

  private String completeReport() {
    return SensitiveData.redact(
        String.valueOf(repository.report.getValue())
            + com.deepseekharness.app.util.UiText.format(
                "\n用户补充复现步骤：\n%s", (steps == null ? "" : steps.getText().toString())));
  }
}
