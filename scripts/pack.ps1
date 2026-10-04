<#
.SYNOPSIS
  dsh-capability-hub 打包脚本：build -> npm pack -> 列出包内文件。

.DESCRIPTION
  手动安装形态是 .tgz 快照。这个脚本把整条流程固化下来：

    1. 校验 package.json 的 files 白名单（漏了 lib/ 就会打出空壳包）；
    2. 运行 build.mjs 生成 lib/index.js 与 lib/client.js；
    3. 用本机 npm 打包到 <工作区根>\dist\（从这里取 tgz）；
    4. 用 tar -tzf 列出包内文件，并断言没有中间产物 lib/.client.raw.js。

  用法（在包根）：
    pwsh -File scripts\pack.ps1
    pwsh -File scripts\pack.ps1 -NoBuild            # 跳过构建，只重打包
    pwsh -File scripts\pack.ps1 -DistDir <目录>      # 换输出目录（默认 <工作区根>\dist）
    pwsh -File scripts\pack.ps1 -Node <node.exe> -Npm <npm.cmd>   # 显式指定解释器

  约定：dist 目录里的 tgz 是**手工安装用的快照**，打完不要删；
  以后升级 = 重新跑本脚本 + 在插件页重装同一个文件。
#>
[CmdletBinding()]
param(
  [switch]$NoBuild,
  [string]$DistDir,
  [string]$Node,
  [string]$Npm
)

$ErrorActionPreference = 'Stop'

$PackageRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot    = Split-Path -Parent $PackageRoot
if (-not $DistDir) { $DistDir = Join-Path $RepoRoot 'dist' }
# 解释器：优先参数 / 环境变量，其次 PATH。不写死某台机器上的安装路径。
if (-not $Node) { $Node = $env:DSH_NODE }
if (-not $Node) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { $cmd = Get-Command node -ErrorAction SilentlyContinue }
  if ($null -ne $cmd) { $Node = $cmd.Source }
}
if (-not $Node) { throw '找不到 node：用 -Node 指定，或把 node 加进 PATH。' }
if (-not $Npm) {
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { $cmd = Get-Command npm -ErrorAction SilentlyContinue }
  if ($null -ne $cmd) { $Npm = $cmd.Source }
}
if (-not $Npm) { throw '找不到 npm：用 -Npm 指定，或把 npm 加进 PATH。' }

# ---- 1. 校验 files 白名单 ------------------------------------------------------
$pkgPath = Join-Path $PackageRoot 'package.json'
$pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
$files = @($pkg.files)
if ($files.Count -eq 0) { throw 'package.json 没有 files 字段：.gitignore 排除了 lib/，直接 pack 会漏掉构建产物。' }
foreach ($required in @('lib/index.js', 'lib/client.js', 'cordis.patch.yml')) {
  if ($files -notcontains $required) { throw "package.json 的 files 少了 $required。" }
}
Write-Output "[pack] 包名 $($pkg.name)@$($pkg.version)，files = $($files -join ', ')"

# ---- 2. 构建 ------------------------------------------------------------------
if (-not $NoBuild) {
  Write-Output '[pack] build ...'
  & $Node (Join-Path $PackageRoot 'build.mjs')
  if ($LASTEXITCODE -ne 0) { throw "build.mjs 退出码 $LASTEXITCODE" }
} else {
  Write-Output '[pack] 跳过构建（-NoBuild）'
}
foreach ($artifact in @('lib\index.js', 'lib\client.js')) {
  $full = Join-Path $PackageRoot $artifact
  if (-not (Test-Path -LiteralPath $full)) { throw "构建产物缺失：$artifact" }
}
$rawPath = Join-Path $PackageRoot 'lib\.client.raw.js'
if (Test-Path -LiteralPath $rawPath) { Remove-Item -LiteralPath $rawPath -Force }

# ---- 3. npm pack --------------------------------------------------------------
if (-not (Test-Path -LiteralPath $DistDir)) { New-Item -ItemType Directory -Path $DistDir -Force | Out-Null }

$packOut = & $Npm pack --pack-destination $DistDir 2>&1
if ($LASTEXITCODE -ne 0) { throw "npm pack 失败：" }
$tgzName = ($packOut | Where-Object { $_ -match '\.tgz$' } | Select-Object -Last 1)
if (-not $tgzName) { throw "没解析出 tgz 文件名：$($packOut -join ' | ')" }
$tgzName = $tgzName.Trim()
$tgzPath = Join-Path $DistDir $tgzName
Write-Output "[pack] tarball: $tgzPath"

# ---- 4. 列出包内文件 ----------------------------------------------------------
$entries = & tar -tzf $tgzPath
if ($LASTEXITCODE -ne 0) { throw 'tar -tzf 失败' }
Write-Output '[pack] 包内文件：'
$entries | ForEach-Object { Write-Output "  $_" }

$expected = @('package/package.json', 'package/lib/index.js', 'package/lib/client.js', 'package/cordis.patch.yml')
$extra = $entries | Where-Object { $expected -notcontains $_ }
if ($extra) { throw "包里有预期之外的文件：$($extra -join ', ')" }
if ($entries -contains 'package/lib/.client.raw.js') { throw '包内混进了中间产物 lib/.client.raw.js' }

$size = (Get-Item -LiteralPath $tgzPath).Length
Write-Output "[pack] 大小 $size 字节；内容校验通过（仅 $($expected.Count) 项）。"
