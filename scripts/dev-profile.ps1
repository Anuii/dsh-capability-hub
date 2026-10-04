<#
.SYNOPSIS
  dsh-capability-hub 开发 profile（capability-hub-dev）的启停脚本。

.DESCRIPTION
  把 DSH 的 Electron 可执行文件当 Node 用（ELECTRON_RUN_AS_NODE=1，与 dsh.cmd 完全一致），
  以「真正脱离调用者进程树」的方式后台启动 capability-hub-dev profile，
  日志落在 <repo>\.dev\logs\。
  绝不触碰 desktop profile 与真实用户目录。

  用法：
    pwsh -File scripts\dev-profile.ps1 start
    pwsh -File scripts\dev-profile.ps1 stop
    pwsh -File scripts\dev-profile.ps1 restart
    pwsh -File scripts\dev-profile.ps1 status

  端口默认 19411，可用 -Port 覆盖；profile 名默认 capability-hub-dev，可用 -ProfileName 覆盖。
  DSH 安装目录：优先 -DshInstallDir 参数，其次 $env:DSH_INSTALL_DIR（注意不是 DSH_HOME，那是 DSH 的数据目录），最后按 %LOCALAPPDATA%\Programs\DeepSeek Harness 推导；
  app.asar 内的 cli.js 可用 $env:DSH_CLI 覆盖。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'status',
  [int]$Port = 19411,
  [string]$ProfileName = 'capability-hub-dev',
  [string]$DshInstallDir
)

$ErrorActionPreference = 'Stop'

# ---- 固定路径 ----------------------------------------------------------------
$PackageRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot    = $PackageRoot   # .dev\ 与 dist\ 都在仓库根下（已被 .gitignore 忽略）
$DevRoot     = Join-Path $RepoRoot '.dev'
$LogDir      = Join-Path $DevRoot 'logs'
$OutLog      = Join-Path $LogDir 'dev-profile.out.log'
$ErrLog      = Join-Path $LogDir 'dev-profile.err.log'
$PidFile     = Join-Path $LogDir 'dev-profile.pid'
$Wrapper     = Join-Path $LogDir 'dev-profile-run.cmd'

# DSH 安装目录：不写死具体机器上的路径，按参数 / 环境变量 / %LOCALAPPDATA% 依次推导。
if (-not $DshInstallDir) { $DshInstallDir = $env:DSH_INSTALL_DIR }
if (-not $DshInstallDir) {
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
  $DshInstallDir = Join-Path $localAppData 'Programs\DeepSeek Harness'
}
$DshExe = Join-Path $DshInstallDir 'DeepSeek Harness.exe'
$DshCli = if ($env:DSH_CLI) { $env:DSH_CLI } else {
  Join-Path $DshInstallDir 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
}

# 注意：$DshCli 在 app.asar 内，Test-Path 看不到（asar 是虚拟路径），所以只校验 exe。
if (-not (Test-Path -LiteralPath $DshExe)) { throw "缺少 DSH 可执行文件：$DshExe（用 -DshInstallDir 或 $env:DSH_INSTALL_DIR 指定 DSH 安装目录）" }
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# ---- 工具函数 ----------------------------------------------------------------
function Get-DevPid {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $raw = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($raw -notmatch '^\d+$') { return $null }
  return [int]$raw
}

# 端口监听进程才是「真的在跑」的判据：wrapper cmd 可能在 DSH 起来后自行退出，
# 只按 pid 文件判断会误报未运行（实测）。
function Get-PortOwner([int]$p) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $conn) { return $null }
  return [int]$conn.OwningProcess
}

function Test-DevRunning {
  return $null -ne (Get-PortOwner $Port)
}

function Test-PortListening([int]$p) {
  return $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Port([int]$p, [int]$TimeoutSec = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortListening $p) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Show-Status {
  $running = Test-DevRunning
  $devPid = Get-DevPid
  $listening = Test-PortListening $Port
  Write-Output "profile : $ProfileName"
  Write-Output "port    : $Port  (listening: $listening)"
  Write-Output "pid     : $(if ($null -eq $devPid) { '(none)' } else { $devPid })"
  Write-Output "running : $running"
  Write-Output "outLog  : $OutLog"
  Write-Output "errLog  : $ErrLog"
  if (-not $running -and $listening) {
    Write-Output "警告：端口被占用但不是本脚本启动的进程（可能残留）。"
  }
}

# ---- 动作 --------------------------------------------------------------------
function Start-Dev {
  if (Test-DevRunning) {
    Write-Output "已在运行（pid $(Get-DevPid)）。用 stop 先停，或 restart。"
    Show-Status
    return
  }
  if (Test-PortListening $Port) {
    throw "端口 $Port 已被其他进程占用；先释放端口或改用 -Port。"
  }
  # 为什么不用 Start-Process：它起出来的进程仍在调用者的进程树里，实测会让 harness 的
  # pwsh 调用一直挂到子进程退出（后台服务 = 该次调用永不返回）。Win32_Process.Create
  # 建出来的进程父级是 WmiPrvSE，与调用者解耦，调用可以立刻返回。
  # 代价：环境变量不继承，所以套一层 wrapper .cmd 来设 ELECTRON_RUN_AS_NODE 并重定向日志。
  # 注意：PowerShell 里逗号优先级高于 +，写成 @('a','b','x' + $y) 会把数组拆成多项。
  # 所以先拼好整条命令行，再放进数组。
  $runLine = '"' + $DshExe + '" --expose-internals "' + $DshCli + '" --profile ' + $ProfileName + ' --port ' + $Port + ' --no-open 1> "' + $OutLog + '" 2> "' + $ErrLog + '"'
  $wrapperLines = @('@echo off', 'set "ELECTRON_RUN_AS_NODE=1"', $runLine)
  Set-Content -LiteralPath $Wrapper -Value $wrapperLines -Encoding ascii
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = 'cmd.exe /c "' + $Wrapper + '"'
    CurrentDirectory = $RepoRoot
  }
  if ($created.ReturnValue -ne 0) { throw "Win32_Process.Create 失败：ReturnValue=$($created.ReturnValue)" }
  $procId = [int]$created.ProcessId
  Set-Content -LiteralPath $PidFile -Value $procId -Encoding ascii
  Write-Output "已启动：pid $procId（wrapper cmd；DSH 进程是它的子进程），等待端口 $Port ..."
  if (Wait-Port $Port 60) {
    $owner = Get-PortOwner $Port
    if ($null -ne $owner) { Set-Content -LiteralPath $PidFile -Value $owner -Encoding ascii }
    Write-Output "端口 $Port 已监听（DSH pid $owner）。"
    Write-Output "鉴权：令牌每进程随机，见 $OutLog 里的 token= 一行；scripts\smoke.ps1 会自动取。"
  } else {
    Write-Output "60 秒内端口未监听 —— 看 $ErrLog 与 $OutLog。"
  }
  Show-Status
}

function Stop-Dev {
  $owner = Get-PortOwner $Port
  $devPid = if ($null -ne $owner) { $owner } else { Get-DevPid }
  if ($null -eq $devPid) {
    Write-Output "profile 未在运行（端口 $Port 无人监听）。"
    if (Test-Path -LiteralPath $PidFile) { Remove-Item -LiteralPath $PidFile -Force }
    return
  }
  if ($null -eq $owner) {
    Write-Output "端口 $Port 没有监听者，但 pid 文件里有 $devPid；按残留进程处理。"
  }
  # 整棵进程树一起收（wrapper cmd -> DSH）。
  & taskkill.exe /PID $devPid /T /F | Out-Null
  Start-Sleep -Milliseconds 800
  if (Test-Path -LiteralPath $PidFile) { Remove-Item -LiteralPath $PidFile -Force }
  Write-Output "已停止 pid $devPid。"
  Show-Status
}

switch ($Action) {
  'start'   { Start-Dev }
  'stop'    { Stop-Dev }
  'restart' { Stop-Dev; Start-Sleep -Seconds 1; Start-Dev }
  'status'  { Show-Status }
}
