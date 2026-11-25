# Dot-source from a plugin folder to put Node.js on PATH for this shell:
#   . .\scripts\env.ps1
# A portable Node in ..\.tools\node (not committed) is used when present; otherwise an installed Node 20+.
$tools = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) ".tools"
if (Test-Path (Join-Path $tools "node\node.exe")) {
  $env:PATH = "$tools\node;$env:PATH"
  $env:npm_config_cache = "$tools\npm-cache"
} elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Warning "Node.js not found. Install Node 20 or later, or unzip a portable build into $tools\node."
}
$env:npm_config_update_notifier = "false"
