param([string]$Project = $PSScriptRoot, [string]$ModelRoot)
$ErrorActionPreference = 'Stop'
$projectPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project)
$modelPath = if ($ModelRoot) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ModelRoot) } else { $null }
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw 'Create .venv and install nexgent first; see README.md.'
}
$env:PYTHONPATH = Join-Path $PSScriptRoot 'src'
$env:NEXGENT_PROJECT_ROOT = $projectPath
$env:PYTHONIOENCODING = 'utf-8'
Set-Location -LiteralPath $PSScriptRoot
$appArgs = @('--project', $projectPath)
if ($modelPath) {
    $appArgs += @('--model-root', $modelPath)
}
& $pythonPath -X utf8 -m nexgent.ui.app @appArgs
exit $LASTEXITCODE
