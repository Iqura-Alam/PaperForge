[CmdletBinding()]
param()

$workspaceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$localRoot = Join-Path $workspaceRoot '.codex-local'
$binRoot = Join-Path $localRoot 'bin'
$tempRoot = Join-Path $localRoot 'tmp'

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$env:PATH = "$binRoot;$env:PATH"
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:UV_CACHE_DIR = Join-Path $localRoot 'uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $localRoot 'uv-python'
$env:UV_TOOL_DIR = Join-Path $localRoot 'uv-tools'
$env:UV_TOOL_BIN_DIR = $binRoot
$env:IMPECCABLE_HOME = Join-Path $localRoot 'impeccable-home'

Set-Location -LiteralPath $workspaceRoot

Write-Host 'PaperForge Codex environment activated.' -ForegroundColor Green
Write-Host "Workspace: $workspaceRoot"
Write-Host "Local tools: $binRoot"
Write-Host 'Run codex to start the CLI, or continue using this folder in the Codex desktop app.'

