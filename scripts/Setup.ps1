#Requires -Version 7.4
[CmdletBinding()]
param(
    [string]$ClaudePath,
    [string]$ChromePath,
    [string]$McpConfig,
    [string]$UpstreamBaseUrl,
    [string]$Registry = 'https://registry.npmjs.org/',
    [ValidateRange(1024, 65535)][int]$GatewayPort = 4145,
    [ValidateRange(1024, 65535)][int]$UpstreamPort = 4144
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot 'Common.ps1')
if (-not $IsWindows) { throw 'The setup scripts support Windows. The Node gateway can be run separately on other platforms.' }
$repoRoot = Get-M365RepositoryRoot
$dataDir = Get-M365DataDirectory
Protect-M365DataDirectory $dataDir
$configPath = Join-Path $dataDir 'config.json'
$previous = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
$processDirectory = Join-Path $dataDir 'processes'
if (Test-Path -LiteralPath $processDirectory) {
    foreach ($recordFile in Get-ChildItem -LiteralPath $processDirectory -Filter '*.json') {
        $record = Get-Content -LiteralPath $recordFile.FullName -Raw | ConvertFrom-Json
        $candidate = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.Path -eq $record.executable -and
            $candidate.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.startTimeTicks) {
            throw 'Stop the owned services with scripts/Manage.ps1 -Action Stop before rerunning setup.'
        }
    }
}
if (-not $PSBoundParameters.ContainsKey('GatewayPort') -and $previous.gatewayPort) { $GatewayPort = $previous.gatewayPort }
if (-not $PSBoundParameters.ContainsKey('UpstreamPort') -and $previous.upstreamPort) { $UpstreamPort = $previous.upstreamPort }
if (-not $PSBoundParameters.ContainsKey('UpstreamBaseUrl') -and $previous.upstreamMode -eq 'external') { $UpstreamBaseUrl = $previous.upstreamBaseUrl }
if (-not $PSBoundParameters.ContainsKey('Registry') -and $previous.registry) { $Registry = $previous.registry }
if (([uri]$Registry).Scheme -ne 'https' -or ([uri]$Registry).UserInfo) { throw 'Use an HTTPS registry URL without embedded credentials.' }
if ($GatewayPort -eq $UpstreamPort -and -not $UpstreamBaseUrl) { throw 'Gateway and upstream ports must be different.' }

$node = Find-M365Application @('node.exe')
$git = Find-M365Application @('git.exe')
$npm = Find-M365Application @('npm.cmd')
$npx = Find-M365Application @('npx.cmd')
if (-not $node -or -not $git -or -not $npm -or -not $npx) { throw 'Install Node.js 24+ and Git, then rerun setup.' }
$nodeVersion = (& $node --version).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node.js 24 or newer is required.' }
if (-not $ClaudePath) { $ClaudePath = $previous.claudePath }
if (-not $ClaudePath) { $ClaudePath = Find-M365Application @('claude.exe', 'claude') }
if (-not $ClaudePath -or -not (Test-Path -LiteralPath $ClaudePath)) {
    throw 'Install Claude Code from https://code.claude.com/docs/en/setup, or provide -ClaudePath.'
}
$ClaudePath = (Resolve-Path -LiteralPath $ClaudePath).Path
$claudeVersionText = (& $ClaudePath --version | Out-String).Trim()
if ($claudeVersionText -notmatch '(\d+\.\d+\.\d+)') { throw 'Could not determine the Claude Code version.' }
$claudeVersion = $Matches[1]
if ([version]$claudeVersion -lt [version]'2.1.280') { throw 'Claude Code 2.1.280 or newer is required for this model picker.' }

$upstreamDir = Join-Path $repoRoot '.runtime\m365-copilot-proxy'
if (-not $UpstreamBaseUrl) {
    if (-not $ChromePath) { $ChromePath = $previous.chromePath }
    if (-not $ChromePath) { $ChromePath = $env:CHROMIUM_PATH }
    if (-not $ChromePath) {
        $programRoots = @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
            [Environment]::GetFolderPath('LocalApplicationData'))
        $candidates = @($programRoots | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Google\Chrome\Application\chrome.exe' })
        $ChromePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
    if (-not $ChromePath -or -not (Test-Path -LiteralPath $ChromePath)) {
        throw 'Install Chrome, or provide -ChromePath for Microsoft interactive sign-in.'
    }
    $pin = Get-Content -LiteralPath (Join-Path $repoRoot 'upstream.json') -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $upstreamDir)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $upstreamDir) -Force | Out-Null
        Invoke-M365Checked $git @('clone', '--filter=blob:none', '--no-checkout', $pin.repository, $upstreamDir)
        Invoke-M365Checked $git @('-C', $upstreamDir, 'checkout', '--detach', $pin.commit)
    }
    $actualCommit = (& $git -C $upstreamDir rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $pin.commit) {
        throw 'The cached upstream checkout does not match upstream.json. No checkout was reset.'
    }
    $patchPath = Join-Path $repoRoot $pin.patch
    & $git -C $upstreamDir apply --reverse --check $patchPath 2>$null
    if ($LASTEXITCODE -ne 0) {
        Invoke-M365Checked $git @('-C', $upstreamDir, 'apply', '--check', $patchPath)
        Invoke-M365Checked $git @('-C', $upstreamDir, 'apply', $patchPath)
    }
}

$originalDirectory = Get-Location
$oldRegistry = $env:npm_config_registry
try {
    $env:npm_config_registry = $Registry
    Set-Location -LiteralPath $repoRoot
    Invoke-M365Checked $npm @('ci', '--ignore-scripts')
    if (-not $UpstreamBaseUrl) {
        Set-Location -LiteralPath $upstreamDir
        Invoke-M365Checked $npx @('--yes', ('pnpm@' + $pin.pnpmVersion), 'install', '--frozen-lockfile')
        Invoke-M365Checked $npx @('--yes', ('pnpm@' + $pin.pnpmVersion), 'run', 'build')
    }
} finally {
    $env:npm_config_registry = $oldRegistry
    Set-Location -LiteralPath $originalDirectory.Path
}

$keyPath = Join-Path $dataDir 'gateway-key.txt'
if (-not (Test-Path -LiteralPath $keyPath)) {
    $key = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    [IO.File]::WriteAllText($keyPath, $key, [Text.UTF8Encoding]::new($false))
}
$mcpPath = Join-Path $dataDir 'mcp.json'
if ($McpConfig) { Write-M365Json $mcpPath (Get-Content -LiteralPath $McpConfig -Raw | ConvertFrom-Json -AsHashtable) }
elseif (-not (Test-Path -LiteralPath $mcpPath)) { Write-M365Json $mcpPath @{ mcpServers = @{} } }
$profileDir = Join-Path $dataDir 'claude'
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
$settingsPath = Join-Path $profileDir 'settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) { Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable } else { @{ theme = 'dark' } }
$catalog = Get-Content -LiteralPath (Join-Path $repoRoot 'src\models.json') -Raw | ConvertFrom-Json
$settings.modelPicker = @{
    replaceBuiltInOptions = $true
    options = @($catalog.models | ForEach-Object {
        @{ model = ($_.clientModel ?? $_.id); label = $_.label; description = $_.description; behavesAs = $_.behavesAs }
    })
}
$settings.availableModels = @($catalog.models | ForEach-Object { $_.id; $_.aliases; 'm365,' + $_.id })
Write-M365Json $settingsPath $settings
$onboardingPath = Join-Path $profileDir '.claude.json'
$onboarding = if (Test-Path -LiteralPath $onboardingPath) { Get-Content -LiteralPath $onboardingPath -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
# This private profile is configured for the local gateway. Workspace trust and
# tool approvals remain native Claude Code decisions.
$onboarding.hasCompletedOnboarding = $true
$onboarding.lastOnboardingVersion = $claudeVersion
Write-M365Json $onboardingPath $onboarding
$config = @{
    gatewayPort = $GatewayPort
    upstreamPort = $UpstreamPort
    upstreamMode = $(if ($UpstreamBaseUrl) { 'external' } else { 'managed' })
    upstreamBaseUrl = $(if ($UpstreamBaseUrl) { $UpstreamBaseUrl.TrimEnd('/') } else { 'http://127.0.0.1:' + $UpstreamPort + '/v1' })
    upstreamDirectory = $upstreamDir
    claudePath = $ClaudePath
    chromePath = $ChromePath
    timeoutMs = 240000
    registry = $Registry
}
Write-M365Json $configPath $config
Write-Output 'Setup complete. No account credentials were requested or copied.'
Write-Output 'Run .\m365-claude.ps1 to start. Complete Microsoft sign-in in the browser if prompted.'
