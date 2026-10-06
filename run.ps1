[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Project = $PSScriptRoot,
    [string]$SessionId,
    [switch]$Json,
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]]$Task
)
$ErrorActionPreference = 'Stop'
$projectPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project)
$launcherPath = Join-Path $PSScriptRoot 'runtime\apps\cli\lib\bin.js'
if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw 'Build the native application first; see docs/native-application.md.'
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$oldHome = $env:DSH_HOME
$oldTelemetry = $env:DSH_TELEMETRY_MODE
try {
    $env:DSH_HOME = Join-Path $projectPath '.nexgent\native'
    $env:DSH_TELEMETRY_MODE = 'OFF'
    Push-Location -LiteralPath $projectPath
    try {
        $nativeArgs = @('--profile', 'nexgent-run')
        if ($SessionId) { $nativeArgs += @('--session-id', $SessionId) }
        if ($Json) { $nativeArgs += '--json' }
        & $nodePath $launcherPath @nativeArgs -- @Task
        $nativeExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    $env:DSH_HOME = $oldHome
    $env:DSH_TELEMETRY_MODE = $oldTelemetry
}
exit $nativeExit
