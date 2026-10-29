package com.deepseekharness.app.core;

import android.content.Context;

/** 独立原生授权存储，不从环境、插件文件或备份自动恢复授权。 */
public final class DeviceGrants {
  private final android.content.SharedPreferences preferences;

  public DeviceGrants(Context context) {
    preferences = context.getSharedPreferences("dsha_device_grants", Context.MODE_PRIVATE);
  }

  public boolean smsReadAllowed() {
    return preferences.getBoolean("sms_read", false);
  }

  public boolean setSmsReadAllowed(boolean allowed) {
    return preferences.edit().putBoolean("sms_read", allowed).commit();
  }

  /** 设备命令护栏授权总闸：开启后允许放行被 {@code DeviceShellPolicy} 拦截的命令。 */
  public boolean deviceShellOverride() {
    return preferences.getBoolean("device_shell_override", false);
  }

  public boolean setDeviceShellOverride(boolean allowed) {
    return preferences.edit().putBoolean("device_shell_override", allowed).commit();
  }

  /** 是否允许「设备安装/卸载类」命令（如 pm install / pm uninstall，仍拒绝分区、SELinux、挂载、刷机）。 */
  public boolean deviceInstallAllowed() {
    return preferences.getBoolean("device_install", false);
  }

  public boolean setDeviceInstallAllowed(boolean allowed) {
    return preferences.edit().putBoolean("device_install", allowed).commit();
  }

  /** 是否放开「高危设备命令」（BLOCK 组：分区、SELinux、setprop、mount、刷机等）。默认必须显式打开。 */
  public boolean deviceDangerousCommandAllowed() {
    return preferences.getBoolean("device_dangerous", false);
  }

  public boolean setDeviceDangerousCommandAllowed(boolean allowed) {
    return preferences.edit().putBoolean("device_dangerous", allowed).commit();
  }

  /** 把本对象里的护栏授权位同步到进程级 {@code DeviceShellPolicy}，所有 shell 通道统一生效。 */
  public void syncIntoPolicy() {
    syncShellOverrides(this);
  }

  /** 从 DeviceGrants 读取授权位并应用到进程级 DeviceShellPolicy（静态便捷入口）。 */
  public static void syncShellOverrides(DeviceGrants grants) {
    com.deepseekharness.app.util.DeviceShellPolicy.setProcessOverrides(
        new com.deepseekharness.app.util.DeviceShellPolicy.Overrides(
            grants.deviceInstallAllowed(),
            grants.deviceShellOverride(),
            grants.deviceDangerousCommandAllowed()));
  }
}
