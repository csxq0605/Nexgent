# Adapted from Nexgent PR #4 (refactor/dsh-application) run.ps1: same parameter design
# (-Project, -SessionId, -Json, positional task words), retargeted at `nexgent run` / `resume`.
<#
.SYNOPSIS
Run a Nexgent task from PowerShell.

.EXAMPLE
./nexgent.ps1 -Project C:\work\proj Write a hello.txt file
./nexgent.ps1 -Project C:\work\proj -SessionId <id> Continue with the README
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Project = (Get-Location).Path,
    [string]$SessionId,
    [ValidateSet('read-only', 'workspace-write', 'full-access')][string]$Sandbox,
    [string]$Model,
    [switch]$Json,
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]]$Task
)
$ErrorActionPreference = 'Stop'
$projectPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project)
$launcherPath = Join-Path $PSScriptRoot 'nexgent.mjs'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$taskText = ($Task -join ' ').Trim()

if ($SessionId) {
    if ($Model) { throw '-Model applies only to a new session; a resumed session keeps its model.' }
    $nexgentArgs = @('resume', $SessionId, '--project', $projectPath)
} else {
    if (-not $taskText) { throw 'Give the task as the remaining arguments.' }
    $nexgentArgs = @('run', '--project', $projectPath)
    if ($Model) { $nexgentArgs += @('--model', $Model) }
}
# `--task=<text>` keeps a task that starts with '-' from being read as an option.
if ($taskText) { $nexgentArgs += "--task=$taskText" }
if ($Sandbox) { $nexgentArgs += @('--sandbox', $Sandbox) }
if ($Json) { $nexgentArgs += '--json' }

& $nodePath $launcherPath @nexgentArgs
exit $LASTEXITCODE
