/**
 * Windows process-tree containment with a Job Object (`permissions.md`
 * §已知边界, step-2 work partition W7). Node cannot create a Job Object
 * without a native addon, so the runner starts a small `pwsh` launcher that
 * puts itself into a new job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and
 * then starts the real command, which inherits the job and the launcher's
 * standard handles. The job handle is held only by the launcher, so when the
 * launcher exits or is killed every process still in the job (descendants
 * whose parent already exited included) is terminated by the system.
 *
 * The P/Invoke source is written once to the temp directory
 * (`nexgent-job-<hash>.cs`), compiled by the first launcher into
 * `nexgent-job-<hash>.dll` and loaded from there afterwards; the spec passed
 * through the environment stays small. When the job
 * cannot be created the launcher still runs the command, and the runner's
 * `taskkill /T` fallback applies.
 */
import { createHash } from 'node:crypto'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Exit code the launcher uses when the command itself could not be started. */
export const JOB_START_FAILED_EXIT = 9009
/** Prefix of the launcher's stderr line for a command that could not be started. */
export const JOB_START_FAILED_MARKER = 'nexgent-job: start-failed: '
/** Environment variable carrying the launch spec to the launcher; removed before the command starts. */
export const JOB_SPEC_ENV = 'NEXGENT_JOB_SPEC'

/** C# for `NexgentJob.Enter()`: create a kill-on-close job and assign the current process to it. */
export const JOB_SOURCE = `using System;
using System.Runtime.InteropServices;
public static class NexgentJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static bool Enter() {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return false;
    Extended info = new Extended();
    info.BasicLimitInformation.LimitFlags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) return false;
    return AssignProcessToJobObject(job, GetCurrentProcess());
  }
}
`

/** The compiled helper's path: temp dir + a hash of {@link JOB_SOURCE}; the source sits next to it as `.cs`. */
export function jobAssemblyPath(): string {
  const hash = createHash('sha256').update(JOB_SOURCE).digest('hex').slice(0, 16)
  return join(tmpdir(), `nexgent-job-${hash}.dll`)
}

let sourceReady = false

/** Write {@link JOB_SOURCE} next to the assembly path once (atomic rename; concurrent writers agree). Never throws. */
export function ensureJobSource(dll: string = jobAssemblyPath()): void {
  if (sourceReady) return
  const source = dll.replace(/\.dll$/, '.cs')
  try {
    if (!existsSync(dll) && !existsSync(source)) {
      const temp = `${source}.${process.pid}.tmp`
      writeFileSync(temp, JOB_SOURCE)
      renameSync(temp, source)
    }
    sourceReady = true
  } catch {
    // The launcher then fails to compile, runs the command without a job, and taskkill /T remains.
  }
}

/** What the launcher reads from {@link JOB_SPEC_ENV}. */
export interface JobLaunchSpec {
  readonly command: string
  readonly args: readonly string[]
  /** Compiled helper; its source is the same path with `.cs`. */
  readonly dll: string
  /** `PSModulePath` as the runner computed it, restored for the command (`null` = unset). */
  readonly psModulePath: string | null
}

/**
 * The launcher script. It never writes to stdout; it exits with the
 * command's exit code, or {@link JOB_START_FAILED_EXIT} after a
 * {@link JOB_START_FAILED_MARKER} line on stderr when the command could not
 * be started.
 */
export const JOB_LAUNCHER = `$ErrorActionPreference = 'Stop'
$spec = [Environment]::GetEnvironmentVariable('${JOB_SPEC_ENV}') | ConvertFrom-Json
[Environment]::SetEnvironmentVariable('${JOB_SPEC_ENV}', $null)
try {
  if (-not ('NexgentJob' -as [type])) {
    if (-not (Test-Path -LiteralPath $spec.dll)) {
      $tmp = [IO.Path]::Combine([IO.Path]::GetDirectoryName($spec.dll), [IO.Path]::GetFileNameWithoutExtension($spec.dll) + '-' + $PID + '.dll')
      Add-Type -Path ([IO.Path]::ChangeExtension($spec.dll, '.cs')) -OutputAssembly $tmp
      try { Move-Item -LiteralPath $tmp -Destination $spec.dll -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
    }
    Add-Type -Path $spec.dll
  }
  $null = [NexgentJob]::Enter()
} catch {
}
$psi = [Diagnostics.ProcessStartInfo]::new([string]$spec.command)
foreach ($arg in @($spec.args)) { $psi.ArgumentList.Add([string]$arg) }
$psi.UseShellExecute = $false
$psi.WorkingDirectory = [Environment]::CurrentDirectory
if ($null -eq $spec.psModulePath) { $null = $psi.Environment.Remove('PSModulePath') } else { $psi.Environment['PSModulePath'] = [string]$spec.psModulePath }
try {
  $child = [Diagnostics.Process]::Start($psi)
} catch {
  [Console]::Error.WriteLine('${JOB_START_FAILED_MARKER}' + $_.Exception.InnerException.Message)
  exit ${JOB_START_FAILED_EXIT}
}
$child.WaitForExit()
exit $child.ExitCode
`

/** `pwsh` arguments that run {@link JOB_LAUNCHER}. */
export function jobLauncherArgs(): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(JOB_LAUNCHER, 'utf16le').toString('base64')]
}

/** The launch spec for one command. */
export function jobLaunchSpec(command: string, args: readonly string[], env: Readonly<Record<string, string>>): JobLaunchSpec {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'psmodulepath')
  const dll = jobAssemblyPath()
  ensureJobSource(dll)
  return { command, args: [...args], dll, psModulePath: key === undefined ? null : env[key]! }
}
