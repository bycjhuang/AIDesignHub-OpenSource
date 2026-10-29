'use strict';
// Installation metadata only; no conversations, credentials or application startup.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let cached;
const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$items = @()
foreach ($base in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  Get-ItemProperty -Path $base | Where-Object { $_.DisplayName -match '^(DeepSeek Harness|DSH Desktop|ZCode|ChatGPT|Hermes)( |$)' } | ForEach-Object {
    $items += @{ kind='registry'; name=$_.DisplayName; version=$_.DisplayVersion; directory=$_.InstallLocation; icon=$_.DisplayIcon }
  }
}
Get-AppxPackage -Name 'OpenAI.*' | Where-Object { $_.Name -in @('OpenAI.ChatGPT','OpenAI.Codex') } | ForEach-Object {
  $items += @{ kind='appx'; name=$_.Name; version=$_.Version.ToString(); directory=$_.InstallLocation }
}
ConvertTo-Json -InputObject @($items) -Compress -Depth 3
`;
function windowsInstallationInventory({ env = process.env, run = spawnSync, now = Date.now, timeoutMs = 2000 } = {}) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) return { items: [], warnings: [] };
  const command = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const key = `${command}|${env.USERPROFILE || ''}`;
  if (run === spawnSync && cached?.key === key && now() - cached.at < 30000) return cached.value;
  const value = { items: [], warnings: [] };
  try {
    if (!fs.statSync(command).isFile()) return value;
    const result = run(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: Math.min(2500, Math.max(100, timeoutMs)), maxBuffer: 128 * 1024,
    });
    if (result.error || result.status !== 0) value.warnings.push('Windows 安装登记检查未完成；其他文件入口检查仍已继续，可稍后重新检测。');
    else {
      const parsed = JSON.parse(String(result.stdout || '[]').replace(/^\uFEFF/, ''));
      value.items = (Array.isArray(parsed) ? parsed : [parsed]).filter(item => item && typeof item.name === 'string').slice(0, 48);
    }
  } catch { value.warnings.push('Windows 安装登记不可读；不影响已找到的本机入口。'); }
  if (run === spawnSync) cached = { key, at: now(), value };
  return value;
}
module.exports = { windowsInstallationInventory };
