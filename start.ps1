param(
    [string]$Project = $PSScriptRoot,
    [switch]$NoOpen,
    [ValidateRange(0, 65535)][int]$Port = 3080,
    [switch]$Check,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$AppArgs
)
$ErrorActionPreference = 'Stop'
$projectPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project)
$runtimePath = Join-Path $PSScriptRoot 'runtime'
$launcherPath = Join-Path $runtimePath 'apps\cli\lib\bin.js'
if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw 'Build the native application first: cd runtime; pnpm install --frozen-lockfile; pnpm run build. See docs/native-application.md.'
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$oldHome = $env:DSH_HOME
$oldTelemetry = $env:DSH_TELEMETRY_MODE
try {
    $env:DSH_HOME = Join-Path $projectPath '.nexgent\native'
    $env:DSH_TELEMETRY_MODE = 'OFF'
    Push-Location -LiteralPath $projectPath
    try {
        if ($Check) {
            & $nodePath $launcherPath --profile nexgent --dump-default-config
        } else {
            $nativeArgs = @('--profile', 'nexgent', '--port', "$Port")
            if ($NoOpen) { $nativeArgs += '--no-open' }
            & $nodePath $launcherPath @nativeArgs @AppArgs
        }
        $nativeExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    $env:DSH_HOME = $oldHome
    $env:DSH_TELEMETRY_MODE = $oldTelemetry
}
exit $nativeExit
