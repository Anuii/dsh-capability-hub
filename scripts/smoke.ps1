<#
.SYNOPSIS
  dsh-capability-hub 的接口冒烟脚本：带 DSH browser-auth 调 /api/dsh-capability-hub/*。

.DESCRIPTION
  DSH 的每个进程随机生成一个 launch token，只有先从 dsh web 的启动行拿到它并换到
  签名 cookie，才能访问 /api（loopback 也不豁免）。
  本脚本：
    1. 从 .dev\logs\dev-profile.out.log 里解析 "dsh web: http://.../?token=..."
    2. curl -c 拿 cookie（GET /?token=... → 303 + Set-Cookie: dsh-auth-*）
    3. 用 cookie 调目标接口，打印 HTTP 状态与响应体
    4. 再不带 cookie 调一次，验证鉴权闸仍然生效（应 401）

  用法：
    pwsh -File scripts\smoke.ps1                       # GET health
    pwsh -File scripts\smoke.ps1 -Path health
    pwsh -File scripts\smoke.ps1 -Path servers -Method POST -Body '{}'
    pwsh -File scripts\smoke.ps1 -Port 19411 -Token <token>   # 手工给令牌
#>
[CmdletBinding()]
param(
  [int]$Port = 19411,
  [string]$Path = 'health',
  [ValidateSet('GET', 'POST')][string]$Method = 'GET',
  [string]$Body,
  [string]$Token
)

$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot    = Split-Path -Parent $PackageRoot
$LogDir      = Join-Path $RepoRoot '.dev\logs'
$OutLog      = Join-Path $LogDir 'dev-profile.out.log'
$Jar         = Join-Path $LogDir 'smoke-cookies.txt'
$BodyFile    = Join-Path $LogDir 'smoke-body.txt'
$Base        = "http://127.0.0.1:$Port"

if (-not (Test-Path -LiteralPath $OutLog)) { throw "找不到启动日志 $OutLog（先跑 scripts\dev-profile.ps1 start）" }

if (-not $Token) {
  $text = Get-Content -LiteralPath $OutLog -Raw
  if ($text -match 'token=([A-Za-z0-9_\-]+)') { $Token = $Matches[1] }
  else { throw "日志里没有 token=... 行；DSH 进程可能没起来（看 dev-profile.err.log）" }
}

Write-Output "== 1. 用 launch token 换 browser-auth cookie =="
$authCode = (& curl.exe -s -o NUL -w '%{http_code}' -c $Jar "$Base/?token=$Token")
Write-Output "GET /?token=<43 字符令牌> -> $authCode （期望 303）"
if (-not (Test-Path -LiteralPath $Jar)) { throw "没有拿到 cookie（状态 $authCode）" }

$target = "$Base/api/dsh-capability-hub/$Path"
Write-Output ""
Write-Output "== 2. 带 cookie 调用 =="
Write-Output "$Method $target"
if ($Body) {
  $code1 = (& curl.exe -s -o $BodyFile -w '%{http_code}' -b $Jar -X $Method -H 'content-type: application/json' --data-raw $Body $target)
} else {
  $code1 = (& curl.exe -s -o $BodyFile -w '%{http_code}' -b $Jar -X $Method $target)
}
Write-Output "HTTP=$code1"
Write-Output (Get-Content -LiteralPath $BodyFile -Raw)

Write-Output ""
Write-Output "== 3. 不带 cookie 调用（验证 /api 鉴权闸） =="
$code2 = (& curl.exe -s -o $BodyFile -w '%{http_code}' -X $Method $target)
Write-Output "HTTP=$code2 （期望 401）"
Write-Output (Get-Content -LiteralPath $BodyFile -Raw)
