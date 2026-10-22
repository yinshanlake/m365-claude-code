#Requires -Version 7.4
[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Status',
    [ValidateSet('All', 'Backend', 'Gateway')][string]$Service = 'All'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$repoRoot = Get-M365RepositoryRoot
$dataDir = Get-M365DataDirectory
$config = Read-M365Configuration
$node = Find-M365Application @('node.exe')
if (-not $node) { throw 'Node.js is not available.' }
$logDir = Join-Path $dataDir 'logs'
$pidDir = Join-Path $dataDir 'processes'
New-Item -ItemType Directory -Path $logDir, $pidDir -Force | Out-Null
$entries = @()
if ($config.upstreamMode -eq 'managed') {
    $entries += @{ Name = 'Backend'; Port = $config.upstreamPort; Directory = $config.upstreamDirectory;
        Entry = Join-Path $config.upstreamDirectory 'packages\proxy\bin\m365-proxy.mjs' }
}
$entries += @{ Name = 'Gateway'; Port = $config.gatewayPort; Directory = $repoRoot;
    Entry = Join-Path $repoRoot 'src\server.cjs' }
foreach ($entry in $entries) {
    if ($Service -ne 'All' -and $Service -ne $entry.Name) { continue }
    $recordPath = Join-Path $pidDir ($entry.Name + '.json')
    $owned = $null
    if (Test-Path -LiteralPath $recordPath) {
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        $candidate = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.Path -eq $record.executable -and
            $candidate.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.startTimeTicks) { $owned = $candidate }
    }
    if ($Action -eq 'Stop') {
        if ($owned) {
            Stop-Process -Id $owned.Id
            Wait-Process -Id $owned.Id -Timeout 10 -ErrorAction SilentlyContinue
            Write-Output ($entry.Name + ': stopped the owned process.')
        } else { Write-Output ($entry.Name + ': already stopped.') }
        continue
    }
    if ($Action -eq 'Start' -and -not $owned) {
        if (Get-NetTCPConnection -LocalPort $entry.Port -State Listen -ErrorAction SilentlyContinue) {
            throw ('Port ' + $entry.Port + ' is occupied. Choose different ports in Setup.ps1; no existing process was replaced.')
        }
        if (-not (Test-Path -LiteralPath $entry.Entry)) { throw 'The required entry point is missing. Rerun scripts/Setup.ps1.' }
        $launchEnvironment = @{ M365_CLAUDE_DATA_DIR = $dataDir }
        $launchArguments = @(('"' + $entry.Entry + '"'))
        if ($entry.Name -eq 'Gateway') {
            $launchEnvironment.M365_CLAUDE_PORT = $entry.Port.ToString()
            $launchEnvironment.M365_OPENAI_BASE_URL = $config.upstreamBaseUrl
            $launchEnvironment.M365_CLAUDE_KEY = $null
        }
        if ($entry.Name -eq 'Backend') {
            if (-not (Test-Path -LiteralPath (Join-Path $entry.Directory 'packages\proxy\.output\server\index.mjs'))) {
                throw 'The upstream backend is not built. Rerun scripts/Setup.ps1.'
            }
            $launchArguments += $entry.Port.ToString()
            $launchEnvironment.HOST = '127.0.0.1'
            $launchEnvironment.NITRO_HOST = '127.0.0.1'
            $launchEnvironment.CHROMIUM_PATH = $config.chromePath
            $launchEnvironment.M365_ENABLE_INTERACTIVE_APPROVAL = '1'
            $launchEnvironment.M365_NO_INTERACTIVE = '0'
            $launchEnvironment.M365_INTERACTIVE_TIMEOUT_MS = '1800000'
            $launchEnvironment.M365_LOGIN_LOCALE = 'en-US'
            $launchEnvironment.M365_HOST_SHELL = 'bash'
            $launchEnvironment.M365_FRAMING_VARIANT = 'relay'
            $launchEnvironment.M365_FORCE_AGENT = '0'
            $launchEnvironment.M365_OPUS_FALLBACK_MODEL = $null
            $launchEnvironment.M365_SONNET_FALLBACK_MODEL = $null
        }
        $startOptions = @{
            FilePath = $node; ArgumentList = $launchArguments; WorkingDirectory = $entry.Directory
            Environment = $launchEnvironment; WindowStyle = 'Hidden'; PassThru = $true
            RedirectStandardOutput = (Join-Path $logDir ($entry.Name + '.stdout.log'))
            RedirectStandardError = (Join-Path $logDir ($entry.Name + '.stderr.log'))
        }
        $owned = Start-Process @startOptions
        Write-M365Json $recordPath @{
            processId = $owned.Id; executable = $node
            startTimeTicks = $owned.StartTime.ToUniversalTime().Ticks.ToString()
        }
    }
    $listener = Get-NetTCPConnection -LocalPort $entry.Port -State Listen -ErrorAction SilentlyContinue
    [pscustomobject]@{
        Service = $entry.Name
        Status = $(if (-not $owned) { 'Stopped' } elseif ($listener.OwningProcess -contains $owned.Id) { 'Listening' } else { 'Starting / waiting for sign-in' })
        ProcessId = $(if ($owned) { $owned.Id } else { $null })
        URL = 'http://127.0.0.1:' + $entry.Port
    }
}
