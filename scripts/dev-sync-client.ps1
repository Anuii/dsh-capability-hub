<#
.SYNOPSIS
  dsh-capability-hub 客户端热同步：build + 只把 lib\client.js 复制进测试 profile。

.DESCRIPTION
  改界面的日常循环都靠这个脚本：
  改客户端源码 -> 运行本脚本 -> 浏览器刷新页面即可看到新界面。
  **不跑 pnpm、不跑 dsh plugin、不重启 DSH（除非显式 -Restart）。**

  为什么刷新就能生效（宿主侧机制，已核实）：
    * @deepseek-ai/dsh-client-modules 以 /plugins/<id>/client.js?rev=<rev> 提供产物，
      rev = hash(mtimeMs, ctimeMs, size)；
    * 该包内部的 rebuilt(id) 是「构建变化进入 graph」的唯一入口；
    * @deepseek-ai/dsh-client-hmr 每 500ms 轮询每个 bundle 的 stat，变化即 rebuilt()，
      并经 /plugins/events(SSE) 把新 rev 推给浏览器。
  所以覆盖文件后最多等一个轮询周期，刷新页面就会请求新的 rev。

  安全：目标目录必须是**真实目录**（Attributes 里没有 ReparsePoint、LinkType 为空），
  否则立刻退出并报错。例外：link 方式（目标是 scripts\dev-link.ps1 建的 junction）下改为调用
  dev-link.ps1 sync，由它核对链接目标正好是暂存目录。这条检查是为了防止包管理器顺着 junction 删除时把源码目录一起清空
  （见 docs/DEV.md 第 4 节）。

  用法（在包根）：
    pwsh -NoProfile -File scripts\dev-sync-client.ps1
    pwsh -NoProfile -File scripts\dev-sync-client.ps1 -NoBuild        # 跳过 build，只复制
    pwsh -NoProfile -File scripts\dev-sync-client.ps1 -Restart       # 复制完重启 dev profile
#>
[CmdletBinding()]
param(
  # 跳过 build.mjs（已经构建过、只想复制时用）
  [switch]$NoBuild,
  # 复制完调用 scripts\dev-profile.ps1 restart（默认不做：实测不需要重启）
  [switch]$Restart,
  # dev profile 端口（只用于打印进程号 / 重启）
  [int]$Port = 19411,
  # profile 名（默认 capability-hub-dev；只写测试 profile，绝不写 desktop）
  [string]$ProfileName = 'capability-hub-dev'
)

$ErrorActionPreference = 'Stop'

$PackageRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot    = $PackageRoot
$SourceClient = Join-Path $PackageRoot 'lib\client.js'
$ProfileRoot  = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $ProfileName)
$TargetDir    = Join-Path $ProfileRoot 'node_modules\dsh-capability-hub'
$TargetClient = Join-Path $TargetDir 'lib\client.js'

# desktop profile 与真实用户目录一律不动。
if ($ProfileName -eq 'desktop') { throw '拒绝：本脚本绝不写 desktop profile。' }

function Get-NodeExe {
  if ($env:DSH_NODE -and (Test-Path -LiteralPath $env:DSH_NODE)) { return $env:DSH_NODE }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { $cmd = Get-Command node -ErrorAction SilentlyContinue }
  if ($null -ne $cmd) { return $cmd.Source }
  throw '找不到 node：把 node 加进 PATH，或用 $env:DSH_NODE 指定。'
}

<#
  检查一个路径是「真实目录」：存在、是目录、不是重解析点、LinkType 为空、
  Target 为空，且 Resolve-Path 后的绝对路径与传入路径一致（父级也没有被重定向）。
#>
function Assert-RealDirectory([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "安全检查失败：$Label 不存在 —— $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) {
    throw "安全检查失败：$Label 不是目录 —— $Path"
  }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "安全检查失败：$Label 是重解析点（ReparsePoint / Junction / Symlink）—— $Path  Attributes=$($item.Attributes)"
  }
  if (-not [string]::IsNullOrEmpty($item.LinkType)) {
    throw "安全检查失败：$Label 的 LinkType = '$($item.LinkType)'（必须是空）—— $Path"
  }
  if ($null -ne $item.Target -and @($item.Target).Count -gt 0) {
    throw "安全检查失败：$Label 的 Target = '$($item.Target)'（必须是空）—— $Path"
  }
  $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath.TrimEnd('\')
  $literal  = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($resolved -ne $literal) {
    throw "安全检查失败：$Label 解析后的真实路径与预期不一致（父级可能是链接）—— 预期 $literal，实际 $resolved"
  }
  return $item
}

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-PortPid([int]$p) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $conn) { return $null }
  return [int]$conn.OwningProcess
}

# ---- 1. build ---------------------------------------------------------------
if (-not $NoBuild) {
  $node = Get-NodeExe
  Write-Output "== build: $node build.mjs"
  Push-Location $PackageRoot
  try {
    & $node 'build.mjs'
    if ($LASTEXITCODE -ne 0) { throw "build.mjs 失败（exit $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
} else {
  Write-Output '== build: 跳过（-NoBuild）'
}

if (-not (Test-Path -LiteralPath $SourceClient)) {
  throw "构建产物不存在：$SourceClient"
}

# ---- 2. 安全检查与复制 ------------------------------------------------------
# link 方式（scripts\dev-link.ps1）：已安装位置是指向暂存目录的 junction，交给 dev-link.ps1 sync 写入暂存目录；
# 它会核对链接目标正好是暂存目录，指向别处一律报错停手。
$installedItem = if (Test-Path -LiteralPath $TargetDir) { Get-Item -LiteralPath $TargetDir -Force } else { $null }
if ($null -ne $installedItem -and -not [string]::IsNullOrEmpty($installedItem.LinkType)) {
  Write-Output '== 检测到 link 方式：改用 scripts\dev-link.ps1 sync'
  $linkArgs = @{ NoBuild = $true; Port = $Port; ProfileName = $ProfileName }
  if ($Restart) { $linkArgs.Restart = $true }
  & (Join-Path $PSScriptRoot 'dev-link.ps1') sync @linkArgs
  exit $LASTEXITCODE
}

$pidBefore = Get-PortPid $Port
Write-Output "== target: $TargetClient"
Assert-RealDirectory -Path $ProfileRoot -Label 'profile 根目录' | Out-Null
Assert-RealDirectory -Path (Join-Path $ProfileRoot 'node_modules') -Label 'node_modules' | Out-Null
Assert-RealDirectory -Path $TargetDir -Label 'node_modules\dsh-capability-hub' | Out-Null
Assert-RealDirectory -Path (Join-Path $TargetDir 'lib') -Label 'node_modules\dsh-capability-hub\lib' | Out-Null
Write-Output '== 安全检查通过：目标目录是真实目录（无 ReparsePoint，LinkType 为空）'

$before = Get-Sha256 $TargetClient
$sourceHash = Get-Sha256 $SourceClient

# 为什么不用 Copy-Item 直接了事：File.Copy 会把源的 LastWriteTime 一起带过去，
# 而宿主的 HMR 轮询按 (mtimeMs, ctimeMs, size) 判断变化 —— 元数据没变就不会 rebuilt()，
# 页面刷新拿到的还是旧产物。所以复制后显式把目标 mtime 顶到当前时间。
Copy-Item -LiteralPath $SourceClient -Destination $TargetClient -Force
(Get-Item -LiteralPath $TargetClient -Force).LastWriteTime = Get-Date

$after = Get-Sha256 $TargetClient

Write-Output ''
Write-Output '== SHA256'
Write-Output ("   source  " + $SourceClient)
Write-Output ("           " + $sourceHash)
Write-Output ("   before  " + $(if ($null -eq $before) { '(目标原本不存在)' } else { $before }))
Write-Output ("   after   " + $after)
if ($after -ne $sourceHash) { throw "复制后哈希与源不一致（after $after ≠ source $sourceHash）" }
if ($null -ne $before -and $before -eq $after) {
  Write-Output '== 注意：复制前后字节完全相同（源码没改动），宿主不会产生新 rev。'
} else {
  Write-Output '== 复制成功：字节已变化。'
}

# ---- 3. 进程与后续 ----------------------------------------------------------
Write-Output ''
Write-Output ("== dev profile pid（复制前）: " + $(if ($null -eq $pidBefore) { '(未运行)' } else { $pidBefore }))
Start-Sleep -Milliseconds 1200
$pidAfter = Get-PortPid $Port
Write-Output ("== dev profile pid（复制后）: " + $(if ($null -eq $pidAfter) { '(未运行)' } else { $pidAfter }))
if ($null -ne $pidBefore -and $null -ne $pidAfter -and $pidBefore -eq $pidAfter) {
  Write-Output '== 进程号不变：宿主 client-hmr 已经 reload 过产物，刷新页面即可看到新界面。'
} elseif ($null -ne $pidBefore -and $null -ne $pidAfter) {
  Write-Output "== 警告：进程号变了（$pidBefore -> $pidAfter）。"
}

if ($Restart) {
  Write-Output ''
  Write-Output '== -Restart：调用 scripts\dev-profile.ps1 restart'
  & (Join-Path $PSScriptRoot 'dev-profile.ps1') restart -Port $Port
} else {
  Write-Output '== 下一步：刷新浏览器页面（不需要重启、不需要 pnpm）。'
}
