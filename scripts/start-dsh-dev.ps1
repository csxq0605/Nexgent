[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter(Mandatory=$true)][string]$DshSource,
    [string]$Project,
    [string]$ModelRoot,
    [string]$DependencyPath,
    [switch]$Check,
    [switch]$Cli,
    [Parameter(Position=0, ValueFromRemainingArguments=$true)][string[]]$AppArgs
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = (Resolve-Path -LiteralPath $DshSource).Path
$cliRoot = Join-Path $source 'apps\cli'
$runtimeSource = Join-Path $source 'python\sdk-runtime\src\deepseek_harness_runtime'
foreach ($path in @((Join-Path $cliRoot 'lib\bin.js'), (Join-Path $source 'python\sdk\src\deepseek_harness\__init__.py'), (Join-Path $runtimeSource '__init__.py'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing official built DSH source: $path. See docs/dsh-main.md." }
}
$python = Join-Path $repo '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Create .venv and install nexgent first.' }
$carrier = Join-Path $repo 'validation-workspace\dsh-runtime-dev'
$module = Join-Path $carrier 'deepseek_harness_runtime'
New-Item -ItemType Directory -Path $module -Force | Out-Null
# Copy only official Python runtime source. Never edit the upstream checkout
# or recreate a bundled runtime's private launcher arguments.
foreach ($file in (Get-ChildItem -LiteralPath $runtimeSource -File)) {
    $destination = Join-Path $module $file.Name
    if (Test-Path -LiteralPath $destination) {
        if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) {
            throw 'The local development carrier belongs to another DSH source version. Use the matching source or a separate Nexgent checkout.'
        }
    } else { Copy-Item -LiteralPath $file.FullName -Destination $destination }
}
$scope = Join-Path $module 'runtime\node\node_modules\@deepseek-ai'
New-Item -ItemType Directory -Path $scope -Force | Out-Null
$link = Join-Path $scope 'dsh'
if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link
    if ($item.LinkType -ne 'Junction' -or [string]$item.Target -ne $cliRoot) {
        throw 'The development runtime junction already points elsewhere; refusing to replace it.'
    }
} else { New-Item -ItemType Junction -Path $link -Target $cliRoot | Out-Null }
$env:DSH_RUNTIME_MODE = 'node'
$env:PYTHONPATH = (Join-Path $repo 'src') + ';' + (Join-Path $source 'python\sdk\src') + ';' + $carrier
$env:PYTHONIOENCODING = 'utf-8'
$env:NEXGENT_DSH_DEV_DEPS = if ($DependencyPath) { (Resolve-Path -LiteralPath $DependencyPath).Path } else { '' }
$projectPath = if ($Project) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project) } else { Join-Path $repo 'validation-workspace\main-dsh-project' }
$modelPath = if ($ModelRoot) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ModelRoot) } else { $repo }
$launch = @()
if ($Check) { $launch += '--check' }
elseif ($Cli) {
    if (-not $AppArgs) { throw 'Pass a CLI command such as run after -Cli.' }
    $launch += @('--cli', '--root', $projectPath)
    $launch += $AppArgs
    $launch += @('--model-root', $modelPath)
}
else { $launch += @('--project', $projectPath, '--model-root', $modelPath, '--kernel', 'dsh'); $launch += $AppArgs }
& $python -X utf8 (Join-Path $PSScriptRoot 'run-dsh-dev.py') @launch
exit $LASTEXITCODE
