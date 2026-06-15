#requires -Version 5.0
<#
.SYNOPSIS
    Set this laptop up to share the Kaiba vault and memory brain with another machine over Google Drive.

.DESCRIPTION
    One-time, idempotent, SAFE setup for the laptop side of Kaiba cross-device sync
    (see docs\memory-bridge\08-cross-device-sync.md and docs\memory-bridge\laptop-runbook.md).

    It:
      1. Resolves this laptop's Google Drive mount (-DriveRoot or auto-detect %USERPROFILE%\My Drive).
      2. Creates <Drive>\kaiba-sync\vault and <Drive>\kaiba-sync\brain.
      3. Makes a safety copy of the current vault, then COPIES it into the Drive vault folder.
         It NEVER deletes the original -- it leaves it in place; you just stop using it.
      4. Merges OBSIDIAN_VAULT_PATH and KB_BRAIN_SYNC_DIR into ~\.knowledge-base\.env
         WITHOUT clobbering any other keys (existing values are updated in place, others untouched).
      5. Runs `kb vault reindex` and `kb memory-sync --dry-run`.
      6. Prints a clear next-steps summary.

    It does NOT move kb.db anywhere (kb.db must NEVER go into Drive) and never asks for / stores a password.

.PARAMETER VaultPath
    REQUIRED. Path to this laptop's CURRENT (local, non-synced) Obsidian vault folder.

.PARAMETER DriveRoot
    Optional. This laptop's Google Drive mount root. Defaults to %USERPROFILE%\My Drive if it exists;
    otherwise you are prompted. Do NOT hardcode the desktop's C:\Users\Admin\My Drive -- it may differ here.

.PARAMETER DryRun
    Optional. Show every action without changing anything (no copy, no .env write, no reindex).
    Implies -WhatIf semantics for the file operations.

.EXAMPLE
    .\setup-laptop.ps1 -VaultPath "D:\Notes\MyVault"

.EXAMPLE
    .\setup-laptop.ps1 -VaultPath "D:\Notes\MyVault" -DriveRoot "G:\My Drive" -DryRun

.NOTES
    Run AFTER the other machine has pushed its brain at least once (kb memory-sync there).
    kb.db stays local in ~\.knowledge-base -- this script never touches it.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true, HelpMessage = "Path to this laptop's current local Obsidian vault folder")]
    [string] $VaultPath,

    [Parameter(Mandatory = $false)]
    [string] $DriveRoot,

    [Parameter(Mandatory = $false)]
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# In -DryRun mode, route SupportsShouldProcess through -WhatIf so nothing mutates.
if ($DryRun) { $WhatIfPreference = $true }

function Fail([string] $Message) {
    Write-Host ""
    Write-Error "SETUP FAILED: $Message"
    exit 1
}

function Info([string] $Message)  { Write-Host "  $Message" }
function Step([string] $Message)  { Write-Host ""; Write-Host "==> $Message" -ForegroundColor Cyan }
function Good([string] $Message)  { Write-Host "  [ok] $Message" -ForegroundColor Green }
function Warn2([string] $Message) { Write-Host "  [!]  $Message" -ForegroundColor Yellow }

Write-Host "Kaiba laptop sync setup" -ForegroundColor White
if ($DryRun) { Warn2 "DRY RUN -- no files or settings will be changed." }

# ---------------------------------------------------------------------------
# 1. Resolve and validate the current vault
# ---------------------------------------------------------------------------
Step "Validating the current vault"
if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) {
    Fail "VaultPath '$VaultPath' does not exist or is not a folder. Pass the laptop's current local vault folder via -VaultPath."
}
$VaultPath = (Resolve-Path -LiteralPath $VaultPath).Path
Good "Current vault: $VaultPath"

# ---------------------------------------------------------------------------
# 2. Resolve the laptop's Google Drive mount (NEVER hardcode the desktop's path)
# ---------------------------------------------------------------------------
Step "Resolving this laptop's Google Drive mount"
if (-not $DriveRoot) {
    $candidate = Join-Path $env:USERPROFILE 'My Drive'
    if (Test-Path -LiteralPath $candidate -PathType Container) {
        $DriveRoot = $candidate
        Good "Auto-detected Drive root: $DriveRoot"
    } else {
        Warn2 "Could not auto-detect '$candidate'."
        Warn2 "Make sure Google Drive for Desktop is running and synced, then enter the mount path."
        $DriveRoot = (Read-Host "Enter this laptop's Google Drive root (e.g. G:\My Drive)").Trim('"').Trim()
    }
}
if ([string]::IsNullOrWhiteSpace($DriveRoot)) {
    Fail "No Drive root provided. Re-run with -DriveRoot '<path to your My Drive folder>'."
}
if (-not (Test-Path -LiteralPath $DriveRoot -PathType Container)) {
    Fail "Drive root '$DriveRoot' does not exist. Confirm Google Drive for Desktop is running and the path is correct (it may differ from the desktop's C:\Users\Admin\My Drive)."
}
$DriveRoot = (Resolve-Path -LiteralPath $DriveRoot).Path
Good "Drive root: $DriveRoot"

$SyncRoot    = Join-Path $DriveRoot 'kaiba-sync'
$DriveVault  = Join-Path $SyncRoot  'vault'
$DriveBrain  = Join-Path $SyncRoot  'brain'

# Guard: refuse to operate on a vault that is ALREADY the Drive vault (re-run safety).
$alreadyInDrive = $false
try {
    $vp = $VaultPath.TrimEnd('\') + '\'
    $dp = $DriveVault.TrimEnd('\') + '\'
    if ($vp.StartsWith($dp, [System.StringComparison]::OrdinalIgnoreCase) -or
        $dp.StartsWith($vp, [System.StringComparison]::OrdinalIgnoreCase)) {
        $alreadyInDrive = $true
    }
} catch { }

# ---------------------------------------------------------------------------
# 3. Create the shared layout in Drive
# ---------------------------------------------------------------------------
Step "Creating the shared layout in Drive"
foreach ($d in @($SyncRoot, $DriveVault, $DriveBrain)) {
    if (Test-Path -LiteralPath $d -PathType Container) {
        Good "Exists: $d"
    } elseif ($PSCmdlet.ShouldProcess($d, "Create directory")) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        Good "Created: $d"
    }
}

# ---------------------------------------------------------------------------
# 4. Safety copy + copy vault INTO Drive (never delete the original)
# ---------------------------------------------------------------------------
Step "Copying the vault into Drive (safety copy first; original left in place)"
if ($alreadyInDrive) {
    Good "Vault already lives inside the Drive sync folder -- skipping copy (idempotent)."
} else {
    # 4a. Safety copy of the original, outside Drive.
    $backup = Join-Path $env:USERPROFILE ("kaiba-vault-backup-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    if ($PSCmdlet.ShouldProcess($backup, "Create safety copy of the original vault")) {
        Copy-Item -LiteralPath $VaultPath -Destination $backup -Recurse -Force
        Good "Safety copy: $backup"
    } else {
        Info "(dry run) would create safety copy at: $backup"
    }

    # 4b. Copy vault CONTENTS into <Drive>\kaiba-sync\vault (merge; do not nest).
    if ($PSCmdlet.ShouldProcess($DriveVault, "Copy vault contents into Drive")) {
        $items = Get-ChildItem -LiteralPath $VaultPath -Force
        foreach ($item in $items) {
            Copy-Item -LiteralPath $item.FullName -Destination $DriveVault -Recurse -Force
        }
        Good "Copied vault contents into: $DriveVault"
        Warn2 "Original vault left untouched at: $VaultPath  (delete it ONLY after both machines verify converged)"
    } else {
        Info "(dry run) would copy contents of '$VaultPath' into '$DriveVault'"
    }
    Warn2 "Wait for Google Drive to finish uploading (tray icon = 'Up to date') before syncing the other machine."
}

# ---------------------------------------------------------------------------
# 5. Merge the two env vars into ~\.knowledge-base\.env (no clobber)
# ---------------------------------------------------------------------------
Step "Updating ~\.knowledge-base\.env (merge, no clobber)"
$kbDir   = Join-Path $env:USERPROFILE '.knowledge-base'
$envPath = Join-Path $kbDir '.env'

if (-not (Test-Path -LiteralPath $kbDir -PathType Container)) {
    if ($PSCmdlet.ShouldProcess($kbDir, "Create data dir")) {
        New-Item -ItemType Directory -Force -Path $kbDir | Out-Null
    }
}

# Desired keys for this step. OBSIDIAN_VAULT_PATH now points at the SYNCED vault.
$desired = [ordered]@{
    'OBSIDIAN_VAULT_PATH' = $DriveVault
    'KB_BRAIN_SYNC_DIR'   = $DriveBrain
}

# Read existing lines (preserve everything we don't manage, including comments/blank lines).
$lines = @()
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    $lines = @(Get-Content -LiteralPath $envPath)
}

$result   = New-Object System.Collections.Generic.List[string]
$seen     = @{}
foreach ($line in $lines) {
    $m = [regex]::Match($line, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=')
    if ($m.Success -and $desired.Contains($m.Groups[1].Value)) {
        $key = $m.Groups[1].Value
        if (-not $seen.ContainsKey($key)) {
            $result.Add("$key=$($desired[$key])")   # update existing key in place
            $seen[$key] = $true
            Info "Updated existing key: $key"
        }
        # drop duplicate occurrences of a managed key
    } else {
        $result.Add($line)                          # preserve untouched (other keys, comments, blanks)
    }
}
foreach ($key in $desired.Keys) {
    if (-not $seen.ContainsKey($key)) {
        $result.Add("$key=$($desired[$key])")       # append keys that weren't present
        Info "Added key: $key"
    }
}

if ($PSCmdlet.ShouldProcess($envPath, "Write merged .env")) {
    Set-Content -LiteralPath $envPath -Value $result -Encoding UTF8
    Good "Wrote: $envPath"
} else {
    Info "(dry run) would write the following managed keys to ${envPath}:"
    Info "  OBSIDIAN_VAULT_PATH=$DriveVault"
    Info "  KB_BRAIN_SYNC_DIR=$DriveBrain"
}
Info "Note: KB_PASSWORD is never written by this script -- set it in .env or pass it to 'kb start'."

# ---------------------------------------------------------------------------
# 6. Reindex + first sync dry-run
# ---------------------------------------------------------------------------
$kb = (Get-Command kb -ErrorAction SilentlyContinue)
if (-not $kb) {
    Warn2 "'kb' is not on PATH -- skipping reindex and dry-run sync. Run them yourself after fixing PATH:"
    Info  "  kb vault reindex"
    Info  "  kb memory-sync --dry-run"
} elseif ($DryRun) {
    Step "Skipping 'kb' commands (dry run)"
    Info "Would run: kb vault reindex"
    Info "Would run: kb memory-sync --dry-run"
} else {
    Step "Rebuilding the local vault index"
    if ($PSCmdlet.ShouldProcess('kb vault reindex', 'Run')) {
        & kb vault reindex
        if ($LASTEXITCODE -ne 0) { Warn2 "kb vault reindex exited with code $LASTEXITCODE -- check OBSIDIAN_VAULT_PATH in .env." }
        else { Good "Reindexed from $DriveVault" }
    }

    Step "First memory sync (dry run -- writes nothing)"
    if ($PSCmdlet.ShouldProcess("kb memory-sync --dir=$DriveBrain --dry-run", 'Run')) {
        & kb memory-sync "--dir=$DriveBrain" --dry-run
        if ($LASTEXITCODE -ne 0) { Warn2 "kb memory-sync --dry-run exited with code $LASTEXITCODE -- confirm the other machine has pushed its brain into $DriveBrain." }
    }
}

# ---------------------------------------------------------------------------
# 7. Next steps
# ---------------------------------------------------------------------------
Step "Next steps"
Write-Host @"
  1. Wait until Google Drive shows 'Up to date' (vault uploaded to the desktop).
  2. If you haven't yet:   kb spine install        # session auto-load/save of the brain
  3. Review the dry-run counts above, then run the REAL sync:
         kb memory-sync
     (Trusted merge -- preserves status/confidence. Use this for ongoing sync.
      Use 'kb memory-import <file>' only for a one-off untrusted seed.)
  4. Verify:               kb brief   and   kb search "<a desktop-only term>"
  5. On the OTHER machine, run 'kb memory-sync' too; then both converge.

  Reminders:
   - kb.db NEVER goes into Drive -- only the vault and the NDJSON brain files do.
   - Your original vault is still at: $VaultPath  (delete only after verifying both machines converge).
   - Shared layout:  $DriveVault   and   $DriveBrain
"@ -ForegroundColor Gray

Write-Host ""
Good ("Laptop setup complete" + $(if ($DryRun) { ' (dry run).' } else { '.' }))
