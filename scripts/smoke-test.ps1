<#
  Windows smoke test, run by GitHub Actions on a real Windows desktop:
    1. the window appears and the frontend loads and calls the backend (first start writes the welcome page)
    2. the global hotkey Ctrl+M hides and shows the window
    3. edge hide: docked at the top edge the window slides away when the cursor leaves, and back when it touches the edge
    4. settings and notes from the 0.1.x folder are moved to the new folder
    5. a second launch does not start a second instance
    6. notebooks and daily backup: an empty current notebook gets its first page, and that first change of the day writes today's backup zip
  Checks 1, 4 and 6 fail the build. Checks 2, 3 and 5 depend on the desktop session and only emit warnings.

  The test deletes Minipad Next's data folders in %APPDATA%, so it only runs on CI unless -Force is given.

  Usage: pwsh scripts/smoke-test.ps1 -Exe src-tauri/target/release/minipad-next.exe [-Force]
#>
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
if (-not $env:CI -and -not $Force) {
    throw "This test deletes Minipad Next's settings and notes in %APPDATA%. Run it on a test machine with -Force."
}
$Exe = (Resolve-Path $Exe).Path
# Run from an isolated executable directory: new installs keep notes and backups beside the exe.
# Never touch notes that might exist beside a developer's regular build output.
$TestInstall = Join-Path $env:TEMP "minipad-next-smoke-$PID"
New-Item -ItemType Directory -Force -Path $TestInstall | Out-Null
$TestExe = Join-Path $TestInstall ([IO.Path]::GetFileName($Exe))
Copy-Item -LiteralPath $Exe -Destination $TestExe -Force
$Exe = $TestExe
$ProgramNotes = Join-Path $TestInstall "notes"
$ProgramBackups = Join-Path $TestInstall "backups"
$AppDir = Join-Path $env:APPDATA "io.github.alstarknight.minipadnext"
$OldDir = Join-Path $env:APPDATA "com.minipadnext.app"
$Title = "Minipad Next"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Win32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    // PowerShell turns $null into "" when calling .NET methods, so pass the null class name from here
    public static IntPtr FindByTitle(string title) { return FindWindow(null, title); }
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@

$failures = @()
$warnings = @()
$proc = $null

function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

function Get-MainWindow { [Win32]::FindByTitle($Title) }

# today's local date as yyyy-MM-dd, the date in the daily backup's file name
function Get-Today { (Get-Date).ToString("yyyy-MM-dd", [Globalization.CultureInfo]::InvariantCulture) }

function Get-Top([IntPtr]$Hwnd) {
    $r = New-Object Win32+RECT
    [void][Win32]::GetWindowRect($Hwnd, [ref]$r)
    return $r.Top
}

function Start-App {
    $p = Start-Process -FilePath $Exe -PassThru
    $shown = Wait-Until {
        $p.HasExited -or (((Get-MainWindow) -ne [IntPtr]::Zero) -and [Win32]::IsWindowVisible((Get-MainWindow)))
    } 30
    if ($p.HasExited) { throw "the app exited right after starting (exit code $($p.ExitCode))" }
    if (-not $shown) { throw "the main window did not appear within 30 seconds" }
    return $p
}

function Stop-App($P) {
    if ($P -and -not $P.HasExited) {
        Stop-Process -Id $P.Id -Force
        [void]$P.WaitForExit(10000)
    }
    Start-Sleep -Milliseconds 500
}

function Send-Hotkey {
    # Ctrl+M
    [Win32]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [Win32]::keybd_event(0x4D, 0, 0, [UIntPtr]::Zero)
    [Win32]::keybd_event(0x4D, 0, 2, [UIntPtr]::Zero)
    [Win32]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
}

function Check([string]$Name, [bool]$Required, [scriptblock]$Body) {
    try {
        & $Body
        Write-Host "PASS  $Name"
    } catch {
        if ($Required) {
            Write-Host "FAIL  $Name : $_"
            Write-Host "::error title=Smoke test::$Name : $_"
            $script:failures += "$Name : $_"
        } else {
            Write-Host "WARN  $Name : $_"
            Write-Host "::warning title=Smoke test::$Name : $_"
            $script:warnings += "$Name : $_"
        }
    }
}

Remove-Item -LiteralPath $AppDir, $OldDir -Recurse -Force -ErrorAction SilentlyContinue

# ---- first start ----
Check "first start: the window appears and the frontend writes the welcome page" $true {
    $script:proc = Start-App
    $notes = $ProgramNotes
    $written = Wait-Until { @(Get-ChildItem -LiteralPath $notes -Filter *.md -ErrorAction SilentlyContinue).Count -gt 0 } 30
    if (-not $written) { throw "no page was written to $notes" }
}

if ($proc -and -not $proc.HasExited) {
    $hwnd = Get-MainWindow

    Check "global hotkey Ctrl+M hides and shows the window" $false {
        # The window may start without focus; then the first press only brings it to the front.
        $hidden = $false
        for ($i = 0; $i -lt 3 -and -not $hidden; $i++) {
            Send-Hotkey
            $hidden = Wait-Until { -not [Win32]::IsWindowVisible($hwnd) } 2
        }
        if (-not $hidden) { throw "the window is still visible after pressing Ctrl+M" }
        Send-Hotkey
        if (-not (Wait-Until { [Win32]::IsWindowVisible($hwnd) } 3)) { throw "the window did not come back after pressing Ctrl+M again" }
    }

    Check "edge hide: docked at the top edge it slides away and comes back" $false {
        [void][Win32]::SetForegroundWindow($hwnd)
        # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
        [void][Win32]::SetWindowPos($hwnd, [IntPtr]::Zero, 200, 0, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010)
        $screenHeight = [Win32]::GetSystemMetrics(1)
        [void][Win32]::SetCursorPos(10, $screenHeight - 10)
        if (-not (Wait-Until { (Get-Top $hwnd) -lt -100 } 5)) { throw "the window did not slide into the top edge (top = $(Get-Top $hwnd))" }
        [void][Win32]::SetCursorPos(260, 0)
        if (-not (Wait-Until { (Get-Top $hwnd) -ge -1 } 5)) { throw "the window did not slide back out (top = $(Get-Top $hwnd))" }
    }
}
Stop-App $proc
$proc = $null

# ---- upgrade from 0.1.x ----
Check "settings and notes from the 0.1.x folder are migrated" $true {
    Remove-Item -LiteralPath $AppDir, $ProgramNotes, $ProgramBackups -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Join-Path $OldDir "notes") | Out-Null
    Set-Content -LiteralPath (Join-Path $OldDir "notes\from-v01.md") -Value "hello from 0.1" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $OldDir "settings.json") -Value '{"hotkey":"Ctrl+Alt+M","edge_hide":false}' -Encoding utf8
    $script:proc = Start-App
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir "notes\from-v01.md"))) { throw "the old page was not migrated" }
    $settings = Get-Content -LiteralPath (Join-Path $AppDir "settings.json") -Raw | ConvertFrom-Json
    if ($settings.hotkey -ne "Ctrl+Alt+M") { throw "the old settings were not migrated" }
    Start-Sleep -Seconds 3
    $count = @(Get-ChildItem -LiteralPath (Join-Path $AppDir "notes") -Filter *.md).Count
    if ($count -ne 1) { throw "expected only the migrated page, found $count pages" }
}

if ($proc -and -not $proc.HasExited) {
    Check "a second launch does not start a second instance" $false {
        $second = Start-Process -FilePath $Exe -PassThru
        if (-not $second.WaitForExit(15000)) {
            Stop-Process -Id $second.Id -Force
            throw "the second instance kept running"
        }
        if ($proc.HasExited) { throw "the first instance exited" }
    }
}
Stop-App $proc
$proc = $null

# ---- notebooks and daily backup ----
Check "notebooks and daily backup" $true {
    Remove-Item -LiteralPath $AppDir, $OldDir, $ProgramNotes, $ProgramBackups -Recurse -Force -ErrorAction SilentlyContinue
    $notes = $ProgramNotes
    $book = Join-Path $notes "Empty"
    $backups = $ProgramBackups
    if (Test-Path -LiteralPath $backups) { throw "could not clear the old backups in $backups" }
    # a page in the default notebook, an empty notebook, and the empty notebook remembered as the current one
    New-Item -ItemType Directory -Force -Path $book | Out-Null
    Set-Content -LiteralPath (Join-Path $notes "root.md") -Value "a page in the default notebook" -Encoding utf8
    Set-Content -LiteralPath (Join-Path $notes ".minipad.json") -Value '{"book":"Empty"}' -Encoding utf8
    $day = Get-Today
    $script:proc = Start-App
    # the frontend gives the empty current notebook its first page through create_note
    $created = Wait-Until { @(Get-ChildItem -LiteralPath $book -Filter *.md -ErrorAction SilentlyContinue).Count -gt 0 } 30
    if (-not $created) { throw "no page was created in the empty current notebook $book" }
    # that is the first change of the day, so the backend zips the notes folder into today's backup
    $zipped = Wait-Until {
        $now = Get-Today
        @(Get-ChildItem -LiteralPath $backups -Filter *.zip -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*$day.zip" -or $_.Name -like "*$now.zip" }).Count -gt 0
    } 30
    if (-not $zipped) { throw "no backup for $day was written to $backups" }
}
Stop-App $proc
$proc = $null

Write-Host ""
Write-Host "Required checks failed: $($failures.Count). Optional checks with warnings: $($warnings.Count)."
if ($failures.Count -gt 0) { exit 1 }
