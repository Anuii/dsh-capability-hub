<#
.SYNOPSIS
  dsh-capability-hub 的「安全 link」开发方式：测试 profile 直接加载最新构建，不再每次打包重装。

.DESCRIPTION
  为什么不能直接 link 源码目录：pnpm（v11，hoisted）在 Windows 上移除一个 link: 依赖时，会顺着
  node_modules 里的 junction 把**目标目录的内容整个删掉**（2026-10-05 的事故就是这样把源码目录清空的）。

  本脚本的做法：junction 只指向一个**暂存目录**
      <profile>\.dev-link\dsh-capability-hub
  里面只有可随时重新生成的四个文件（package.json、cordis.patch.yml、lib\index.js、lib\client.js）。
  pnpm 就算顺着链接删，也只会删掉这些产物；源码目录从来不在任何链接的目标里。
  暂存目录放在 profile 目录内，是为了让模块解析的祖先链与 tgz 安装完全一致
  （向上能找到 ~/.dsh/profiles/node_modules 里 DSH 自带的 @modelcontextprotocol/*）。

  动作：
    status   显示依赖说明符、链接目标、暂存目录与仓库 lib 的哈希对比（默认）
    sync     build（-NoBuild 跳过）并把产物写进暂存目录；-Restart 顺带重启 profile
    watch    同 sync，然后前台运行 build.mjs --watch，源码一改就写进暂存目录（Ctrl+C 结束）
    enable   tgz 安装 → link 暂存目录（会停、启 profile）
    disable  link → 重新装 dist 里的 tgz（会停、启 profile）；暂存目录可能被 pnpm 清空，这是预期的

  客户端改动：sync / watch 之后刷新页面即可（宿主 HMR 按文件元数据轮询）。
  宿主改动：sync -Restart，或 watch 时另行 dev-profile.ps1 restart。
  对该 profile 做过任何插件操作（装/卸其他插件）后，pnpm 可能重建链接并清空暂存目录：再跑一次 sync。

  用法（在包根）：
    pwsh -NoProfile -File scripts\dev-link.ps1 status
    pwsh -NoProfile -File scripts\dev-link.ps1 enable
    pwsh -NoProfile -File scripts\dev-link.ps1 sync [-NoBuild] [-Restart]
    pwsh -NoProfile -File scripts\dev-link.ps1 watch
    pwsh -NoProfile -File scripts\dev-link.ps1 disable [-Tgz <路径>]
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'sync', 'watch', 'enable', 'disable')]
  [string]$Action = 'status',
  [switch]$NoBuild,
  [switch]$Restart,
  # disable 时重新安装的 tgz；默认 dist\dsh-capability-hub-<package.json 版本>.tgz
  [string]$Tgz,
  [int]$Port = 19411,
  # 只用于测试 profile；desktop 一律拒绝
  [string]$ProfileName = 'capability-hub-dev',
  [string]$DshInstallDir
)

$ErrorActionPreference = 'Stop'

$PackageRoot = Split-Path -Parent $PSScriptRoot
$PackageName = 'dsh-capability-hub'
if ($ProfileName -eq 'desktop') { throw '拒绝：dev-link 只用于测试 profile，desktop 继续用 tgz 安装。' }

$ProfileRoot = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $ProfileName)
$StageRoot   = Join-Path $ProfileRoot '.dev-link'
$Stage       = Join-Path $StageRoot $PackageName
$Installed   = Join-Path $ProfileRoot ('node_modules\' + $PackageName)
$StageFiles  = @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js')

if (-not $DshInstallDir) { $DshInstallDir = $env:DSH_INSTALL_DIR }
if (-not $DshInstallDir) {
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
  $DshInstallDir = Join-Path $localAppData 'Programs\DeepSeek Harness'
}
$DshExe = Join-Path $DshInstallDir 'DeepSeek Harness.exe'
$DshCli = if ($env:DSH_CLI) { $env:DSH_CLI } else {
  Join-Path $DshInstallDir 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
}

# ---- 工具函数 ----------------------------------------------------------------
function Get-NodeExe {
  if ($env:DSH_NODE -and (Test-Path -LiteralPath $env:DSH_NODE)) { return $env:DSH_NODE }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { $cmd = Get-Command node -ErrorAction SilentlyContinue }
  if ($null -ne $cmd) { return $cmd.Source }
  throw '找不到 node：把 node 加进 PATH，或用 $env:DSH_NODE 指定。'
}

function Get-FullPath([string]$Path) { return [System.IO.Path]::GetFullPath($Path).TrimEnd('\') }

function Test-IsLink($Item) {
  return (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or -not [string]::IsNullOrEmpty($Item.LinkType)
}

# 真实目录：存在、是目录、本身不是链接，且解析后的路径与字面路径一致（祖先也没被重定向）。
function Assert-RealDirectory([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "安全检查失败：$Label 不存在 —— $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) { throw "安全检查失败：$Label 不是目录 —— $Path" }
  if (Test-IsLink $item) { throw "安全检查失败：$Label 是链接（LinkType='$($item.LinkType)'）—— $Path" }
  $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath.TrimEnd('\')
  if ($resolved -ne (Get-FullPath $Path)) { throw "安全检查失败：$Label 的祖先被重定向 —— 预期 $(Get-FullPath $Path)，实际 $resolved" }
}

# 暂存目录必须是 profile 下的真实目录，内部不许有任何链接（否则 pnpm 删除时可能顺着它出去）。
function Assert-StageSafe {
  Assert-RealDirectory -Path $ProfileRoot -Label 'profile 根目录'
  foreach ($p in @($StageRoot, $Stage, (Join-Path $Stage 'lib'))) {
    if (Test-Path -LiteralPath $p) { Assert-RealDirectory -Path $p -Label $p }
  }
  if (Test-Path -LiteralPath $Stage) {
    $links = @(Get-ChildItem -LiteralPath $Stage -Recurse -Force | Where-Object { Test-IsLink $_ })
    if ($links.Count -gt 0) { throw "安全检查失败：暂存目录里有链接：$($links[0].FullName)" }
  }
  $repo = Get-FullPath $PackageRoot
  $stageFull = Get-FullPath $Stage
  if ($stageFull.StartsWith($repo + '\', [System.StringComparison]::OrdinalIgnoreCase) -or $repo.StartsWith($stageFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "安全检查失败：暂存目录与仓库目录互相包含 —— $stageFull / $repo"
  }
}

# 已安装位置的状态：missing / real（tgz 解出的真实目录）/ link（指向暂存目录）。指向别处的链接一律停手。
function Get-InstallState {
  if (-not (Test-Path -LiteralPath $Installed)) { return 'missing' }
  $item = Get-Item -LiteralPath $Installed -Force
  if (-not (Test-IsLink $item)) { return 'real' }
  $target = @($item.Target)[0]
  if ([string]::IsNullOrEmpty($target)) { throw "停手：$Installed 是链接但读不到目标（LinkType='$($item.LinkType)'）。" }
  if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $Installed) $target }
  if ((Get-FullPath $target) -ieq (Get-FullPath $Stage)) { return 'link' }
  throw "停手：$Installed 链接到了暂存目录以外的地方：$target。不要对这个 profile 做任何插件或 pnpm 操作，先人工处理。"
}

function Get-DependencySpec {
  $pj = Join-Path $ProfileRoot 'package.json'
  if (-not (Test-Path -LiteralPath $pj)) { return $null }
  $json = Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json
  if ($null -eq $json.dependencies) { return $null }
  $prop = $json.dependencies.PSObject.Properties[$PackageName]
  if ($null -eq $prop) { return $null }
  return [string]$prop.Value
}

function Get-Sha([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Invoke-DshPlugin([string[]]$PnpmArgs) {
  if (-not (Test-Path -LiteralPath $DshExe)) { throw "缺少 DSH 可执行文件：$DshExe" }
  $old = $env:ELECTRON_RUN_AS_NODE
  $env:ELECTRON_RUN_AS_NODE = '1'
  try {
    Write-Output ("== dsh plugin --profile $ProfileName " + ($PnpmArgs -join ' '))
    # 用管道接输出：DSH 可执行文件是 GUI 子系统，不接管道时 PowerShell 不会等它结束。
    $out = & $DshExe --expose-internals $DshCli plugin --profile $ProfileName @PnpmArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Output $out.TrimEnd()
    if ($code -ne 0) { throw "dsh plugin 退出码 $code" }
  } finally {
    $env:ELECTRON_RUN_AS_NODE = $old
  }
}

function Test-ProfileRunning {
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Invoke-DevProfile([string]$What) {
  & (Join-Path $PSScriptRoot 'dev-profile.ps1') $What -Port $Port -ProfileName $ProfileName
}

# build（可跳过）并把四个文件写进暂存目录。内容不变的文件不重写，变了的把 mtime 顶到当前时间。
function Sync-Stage {
  Assert-StageSafe
  New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'lib') | Out-Null
  Assert-StageSafe
  if (-not $NoBuild) {
    $node = Get-NodeExe
    Push-Location $PackageRoot
    try {
      & $node 'build.mjs' '--also-out' (Join-Path $Stage 'lib')
      if ($LASTEXITCODE -ne 0) { throw "build.mjs 失败（exit $LASTEXITCODE）" }
    } finally { Pop-Location }
  }
  foreach ($f in $StageFiles) {
    $src = Join-Path $PackageRoot $f
    $dst = Join-Path $Stage $f
    if (-not (Test-Path -LiteralPath $src)) { throw "缺少产物：$src（先 build）" }
    if ((Get-Sha $src) -ne (Get-Sha $dst)) {
      Copy-Item -LiteralPath $src -Destination $dst -Force
      (Get-Item -LiteralPath $dst -Force).LastWriteTime = Get-Date
      Write-Output "== 已更新暂存：$f"
    }
  }
  Show-Status
}

function Show-Status {
  $state = Get-InstallState
  Write-Output ''
  Write-Output "profile  : $ProfileName"
  Write-Output "依赖     : $(Get-DependencySpec)"
  Write-Output "安装状态 : $state（link = 指向暂存目录；real = tgz 安装）"
  Write-Output "暂存目录 : $Stage"
  foreach ($f in $StageFiles) {
    $a = Get-Sha (Join-Path $PackageRoot $f)
    $b = Get-Sha (Join-Path $Stage $f)
    $mark = if ($null -eq $b) { '缺失' } elseif ($a -eq $b) { '一致' } else { '不一致' }
    Write-Output ("  {0,-18} {1}" -f $f, $mark)
  }
  Write-Output "运行中   : $(Test-ProfileRunning)（端口 $Port）"
}

# ---- 动作 --------------------------------------------------------------------
switch ($Action) {
  'status' { Show-Status }
  'sync' {
    Sync-Stage
    if ($Restart) { Invoke-DevProfile 'restart' } else { Write-Output '== 客户端改动刷新页面即可；宿主改动加 -Restart。' }
  }
  'watch' {
    Sync-Stage
    $node = Get-NodeExe
    Push-Location $PackageRoot
    try { & $node 'build.mjs' '--watch' '--also-out' (Join-Path $Stage 'lib') } finally { Pop-Location }
  }
  'enable' {
    $state = Get-InstallState
    if ($state -eq 'link') { Write-Output '已经是 link 模式。'; Sync-Stage; break }
    Sync-Stage
    $wasRunning = Test-ProfileRunning
    if ($wasRunning) { Invoke-DevProfile 'stop' }
    $spec = 'link:' + ((Get-FullPath $Stage) -replace '\\', '/')
    Invoke-DshPlugin @('add', $spec)
    $state = Get-InstallState
    if ($state -ne 'link') { throw "切换后状态是 $state，不是 link。" }
    # pnpm 建链接时可能动过目标目录：再核对一次产物。
    Sync-Stage
    if ($wasRunning) { Invoke-DevProfile 'start' }
  }
  'disable' {
    $state = Get-InstallState
    if (-not $Tgz) {
      $version = (Get-Content -LiteralPath (Join-Path $PackageRoot 'package.json') -Raw | ConvertFrom-Json).version
      $Tgz = Join-Path $PackageRoot "dist\$PackageName-$version.tgz"
    }
    if (-not (Test-Path -LiteralPath $Tgz)) { throw "找不到 tgz：$Tgz（先 scripts\pack.ps1，或用 -Tgz 指定）" }
    Assert-StageSafe
    $wasRunning = Test-ProfileRunning
    if ($wasRunning) { Invoke-DevProfile 'stop' }
    $spec = 'file:' + ((Get-FullPath $Tgz) -replace '\\', '/')
    Invoke-DshPlugin @('add', $spec)
    $state = Get-InstallState
    if ($state -ne 'real') { throw "切换后状态是 $state，不是 real。" }
    Show-Status
    if ($wasRunning) { Invoke-DevProfile 'start' }
  }
}
