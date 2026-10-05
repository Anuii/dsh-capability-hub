<#
.SYNOPSIS
  端到端冒烟：带 browser-auth 走完「技能 / MCP 配置 / 运行态 / health」全链路。

.DESCRIPTION
  步骤：

    1  GET  skills/list          → roots 与技能数（夹具 user-agents = 31）
    2  GET  skills/view          → 抽一个技能看正文
    3  POST skills/set-enabled   停用再启用（archify），证明「除那一行外字节不变」
    4  GET  mcp/config           → 加服务器之前的配置
    5  POST mcp/servers/upsert   加一个指向夹具 fake-mcp-server.mjs 的 stdio 服务器
    6  GET  mcp/runtime          轮询到自动探测把 toolCount 写进缓存（> 0）
    7  POST mcp/runtime/refresh  手动刷新一次
    8  GET  health               4 个真实模块 ok、工具描述里有服务器名
    9  GET  skills/github-auth   只看 mode（绝不打印令牌）
   10  POST mcp/servers/delete   收尾：删掉测试服务器，恢复原状

  所有请求都带 cookie（browser-auth）；脚本**不会**打印任何令牌。
  服务器配置写在夹具 home 下（.dev/home/.dsh/storages/dsh-capability-hub/mcp/config.json），
  不触碰任何真实用户目录。

  用法：
    pwsh -NoProfile -File scripts\smoke-stage-b.ps1
    pwsh -NoProfile -File scripts\smoke-stage-b.ps1 -Port 19411 -NodeExe <node.exe>
#>
[CmdletBinding()]
param(
  [int]$Port = 19411,
  [string]$Token,
  [string]$NodeExe
)

$ErrorActionPreference = 'Stop'

$PackageRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot    = $PackageRoot
$LogDir      = Join-Path $RepoRoot ".dev\logs"
$OutLog      = Join-Path $LogDir 'dev-profile.out.log'
$Jar         = Join-Path $LogDir 'smoke-stage-b-cookies.txt'
$BodyFile    = Join-Path $LogDir 'smoke-stage-b-body.json'
$Base        = "http://127.0.0.1:$Port"
$Fixture     = Join-Path $PackageRoot 'test\mcp\runtime\fixtures\fake-mcp-server.mjs'
# 假 MCP 服务器用哪个 node 跑：优先 -NodeExe / $env:DSH_NODE，其次 PATH。
if (-not $NodeExe) { $NodeExe = $env:DSH_NODE }
if (-not $NodeExe) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { $cmd = Get-Command node -ErrorAction SilentlyContinue }
  if ($null -ne $cmd) { $NodeExe = $cmd.Source }
}
if (-not $NodeExe) { throw '找不到 node：用 -NodeExe 指定，或把 node 加进 PATH。' }
$SkillMd     = Join-Path $RepoRoot '.dev\home\.agents\skills\archify\SKILL.md'
$ServerName  = 'stage-b-fake'

$script:Failures = 0
$script:Step = 0

function Say($text) { Write-Output $text }
function Step($text) { $script:Step += 1; Write-Output ""; Write-Output "== $($script:Step). $text ==" }
function Check([bool]$ok, $what) {
  if ($ok) { Write-Output "  [PASS] $what" } else { $script:Failures += 1; Write-Output "  [FAIL] $what" }
}

function Invoke-Hub {
  param([string]$Method, [string]$Path, $Body)
  $target = "$Base/api/dsh-capability-hub/$Path"
  if ($null -ne $Body) {
    $json = ($Body | ConvertTo-Json -Depth 12 -Compress)
    $code = (& curl.exe -s -o $BodyFile -w '%{http_code}' -b $Jar -X $Method -H 'content-type: application/json' --data-raw $json $target)
  } else {
    $code = (& curl.exe -s -o $BodyFile -w '%{http_code}' -b $Jar -X $Method $target)
  }
  $text = ''
  if (Test-Path -LiteralPath $BodyFile) { $text = (Get-Content -LiteralPath $BodyFile -Raw) }
  return [pscustomobject]@{ Code = [int]$code; Text = $text }
}

function Envelope($response) { return ($response.Text | ConvertFrom-Json) }

# ---- 0. 换 cookie（每进程随机令牌，只从启动日志里读，从不打印） ----
if (-not (Test-Path -LiteralPath $OutLog)) { throw "找不到启动日志 $OutLog（先跑 scripts\dev-profile.ps1 start）" }
if (-not $Token) {
  $logText = Get-Content -LiteralPath $OutLog -Raw
  if ($logText -match 'token=([A-Za-z0-9_\-]+)') { $Token = $Matches[1] }
  else { throw "日志里没有 token=... 行" }
}
Step "换 browser-auth cookie"
# 注意：令牌只出现在这条命令的 URL 里，绝不打印（curl 的 -w 只输出状态码）。
$authCode = (& curl.exe -s -o NUL -w '%{http_code}' -c $Jar "$Base/?token=$Token")
Say "  GET /?token=<省略> -> HTTP $authCode （期望 303）"
if ($authCode -ne '303') { throw "换 cookie 失败：HTTP $authCode" }

# ---- 1. skills/list ----
Step "GET skills/list（夹具 user-agents 技能数）"
$list = Envelope (Invoke-Hub GET 'skills/list')
Check ($list.ok -eq $true) "ok=true"
$roots = @($list.data.roots)
$skills = @($list.data.skills)
Say ("  roots: " + (($roots | ForEach-Object { "$($_.rootId)=$($_.exists)" }) -join ', '))
$userAgents = @($skills | Where-Object { $_.rootId -eq 'user-agents' })
Say ("  user-agents 技能数：" + $userAgents.Count + "（期望 31）")
Check ($userAgents.Count -eq 31) "夹具 user-agents 有 31 个技能"
$modelVisible = @($skills | Where-Object { $_.modelVisible })
Say "  modelVisible 数：$($modelVisible.Count)"

# ---- 2. skills/view ----
$archify = $userAgents | Where-Object { $_.dirName -eq 'archify' } | Select-Object -First 1
Step "GET skills/view（archify）"
$view = Envelope (Invoke-Hub GET "skills/view?id=$($archify.id)")
Check ($view.ok -eq $true -and $view.data.skill.id -eq $archify.id) "取到 $($archify.id)"
Say ("  正文前 60 字：" + ($view.data.content.Substring(0, [Math]::Min(60, $view.data.content.Length)) -replace "\r?\n", ' / '))
$fileNames = @($view.data.files | ForEach-Object { $_.path })
Say ("  files（共 " + $fileNames.Count + " 项，前 8 项）：" + (($fileNames | Select-Object -First 8) -join ', '))

# ---- 3. set-enabled 往返 + 字节不变 ----
Step "POST skills/set-enabled（停用 → 启用，逐字节证明）"
$beforeHash = (Get-FileHash -LiteralPath $SkillMd -Algorithm SHA256).Hash
$beforeText = [System.IO.File]::ReadAllText($SkillMd)
$disable = Envelope (Invoke-Hub POST 'skills/set-enabled' @{ id = $archify.id; enabled = $false })
Check ($disable.ok -eq $true -and $disable.data.skill.modelInvocationDisabled -eq $true) "停用成功"
$afterText = [System.IO.File]::ReadAllText($SkillMd)
$beforeLines = $beforeText -split "\r?\n"
$afterLines = $afterText -split "\r?\n"
$diffLines = @()
for ($i = 0; $i -lt [Math]::Max($beforeLines.Count, $afterLines.Count); $i++) {
  $b = if ($i -lt $beforeLines.Count) { $beforeLines[$i] } else { '<无此行>' }
  $a = if ($i -lt $afterLines.Count) { $afterLines[$i] } else { '<无此行>' }
  if ($b -ne $a) { $diffLines += "第 $($i+1) 行：[$(($b).TrimEnd())] -> [$(($a).TrimEnd())]" }
}
Say ("  差异行：" + ($diffLines -join "; "))
Check ($diffLines.Count -eq 1) "只有 1 行变化"
Check ($diffLines[0] -match 'disable-model-invocation') "变化的那一行就是 disable-model-invocation"
$enable = Envelope (Invoke-Hub POST 'skills/set-enabled' @{ id = $archify.id; enabled = $true })
Check ($enable.ok -eq $true -and $enable.data.skill.modelInvocationDisabled -eq $false) "启用成功"
$afterHash = (Get-FileHash -LiteralPath $SkillMd -Algorithm SHA256).Hash
Say "  往返后 SHA256 = $afterHash"
Check ($afterHash -eq $beforeHash) "启用后文件与最初逐字节相同（SHA256 一致）"

# ---- 4. mcp/config ----
Step "GET mcp/config（加服务器之前）"
$config = Envelope (Invoke-Hub GET 'mcp/config')
Check ($config.ok -eq $true) "ok=true"
# 夹具里可能本来就有别的服务器，收尾时只要求「回到运行前的数量」。
# （判据不写死 0，否则夹具里常驻的服务器会让收尾误报失败。）
$serverCountBefore = @($config.data.servers).Count
Say ("  servers: " + $serverCountBefore + "（运行前基线）| settings: " + ($config.data.settings | ConvertTo-Json -Compress))

# ---- 5. upsert 测试服务器 ----
Step "POST mcp/servers/upsert（夹具 fake-mcp-server.mjs）"
$upsert = Envelope (Invoke-Hub POST 'mcp/servers/upsert' @{
  server = @{
    serverName = $ServerName
    transport  = 'stdio'
    command    = $NodeExe
    args       = @($Fixture)
    env        = @{ FAKE_MCP_NO_GRANDCHILD = '1' }
    meta       = @{ description = '冒烟用的假 MCP 服务器（跑完即删）'; tags = @('smoke') }
  }
})
Check ($upsert.ok -eq $true -and $upsert.data.server.serverName -eq $ServerName) "upsert 成功"
Say ("  warnings: " + (($upsert.data.warnings) -join ' | '))

# ---- 6. 等自动探测 ----
Step "等自动探测写缓存（GET mcp/runtime）"
$toolCount = 0
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  $runtime = Envelope (Invoke-Hub GET 'mcp/runtime')
  $server = @($runtime.data.servers) | Where-Object { $_.name -eq $ServerName } | Select-Object -First 1
  if ($null -ne $server -and $null -ne $server.cache -and $server.cache.toolCount -gt 0) { $toolCount = $server.cache.toolCount; break }
}
Check ($toolCount -gt 0) "自动探测后 toolCount = $toolCount（> 0）"
$runtime = Envelope (Invoke-Hub GET 'mcp/runtime')
$server = @($runtime.data.servers) | Where-Object { $_.name -eq $ServerName } | Select-Object -First 1
Say ("  runtime: " + ($server | ConvertTo-Json -Compress))

# ---- 7. refresh ----
Step "POST mcp/runtime/refresh"
$refresh = Envelope (Invoke-Hub POST 'mcp/runtime/refresh' @{ name = $ServerName })
Check ($refresh.ok -eq $true -and $refresh.data.toolCount -gt 0) "refresh 返回 toolCount = $($refresh.data.toolCount)"

# ---- 8. health ----
Step "GET health"
$health = Envelope (Invoke-Hub GET 'health')
$statuses = @($health.data.modules | ForEach-Object { "$($_.name)=$($_.status)" })
Say ("  modules: " + ($statuses -join ', '))
foreach ($name in @('mcp-config', 'skills-local', 'skills-remote', 'mcp-runtime')) {
  $entry = @($health.data.modules) | Where-Object { $_.name -eq $name } | Select-Object -First 1
  Check ($null -ne $entry -and $entry.status -eq 'ok') "模块 $name ok"
}
Check ($health.data.tool.registered -eq $true) "mcp 工具已注册"
Check ($health.data.tool.description -like "*$ServerName*") "工具描述里出现服务器名 $ServerName"
Say ("  工具描述（截断）：" + ($health.data.tool.description.Substring(0, [Math]::Min(140, $health.data.tool.description.Length)) -replace "\r?\n", ' / '))
Say ("  wiring: " + ($health.data.wiring | ConvertTo-Json -Compress))
Say ("  已注册路由数：" + (@($health.data.registration.registered).Count))

# ---- 9. github-auth（只看 mode） ----
Step "GET skills/github-auth（只看 mode，不打印令牌）"
$auth = Envelope (Invoke-Hub GET 'skills/github-auth')
Check ($auth.ok -eq $true -and @('env', 'gh', 'anonymous') -contains $auth.data.mode) "mode = $($auth.data.mode)"
Say ("  响应里出现的字段：" + (($auth.data.PSObject.Properties.Name) -join ', '))

# ---- 10. 收尾：删掉测试服务器 ----
Step "POST mcp/servers/delete（恢复原状）"
$delete = Envelope (Invoke-Hub POST 'mcp/servers/delete' @{ name = $ServerName })
Check ($delete.ok -eq $true) "删除成功"
$config2 = Envelope (Invoke-Hub GET 'mcp/config')
Check (@($config2.data.servers).Count -eq $serverCountBefore) "已无本次新增的测试服务器（数量回到运行前基线 $serverCountBefore）"

Say ""
if ($script:Failures -eq 0) { Say "SMOKE-STAGE-B-RESULT pass=$($script:Step) fail=0" }
else { Say "SMOKE-STAGE-B-RESULT fail=$($script:Failures)"; exit 1 }
