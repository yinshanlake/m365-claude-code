#Requires -Version 7.4
# No advanced parameter binding: --verbose and --debug belong to Claude Code.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Common.ps1')
$options = ConvertTo-M365LaunchOptions -Arguments $args
$config = Read-M365Configuration
$repoRoot = Get-M365RepositoryRoot
$dataDir = Get-M365DataDirectory
$catalog = Get-Content -LiteralPath (Join-Path $repoRoot 'src\models.json') -Raw | ConvertFrom-Json
$claude = $config.claudePath
if (-not (Test-Path -LiteralPath $claude)) { throw 'Claude Code is missing. Rerun scripts/Setup.ps1 -ClaudePath <path>.' }
if ($options.ModelSpecified -and $options.Model -notin $catalog.models.id) { throw ('Unsupported M365 route: ' + $options.Model) }
$nativeArguments = $options.NativeArguments
if ($nativeArguments -contains '--version' -or $nativeArguments -contains '--help') {
    & $claude @nativeArguments
    exit $LASTEXITCODE
}
& (Join-Path $repoRoot 'scripts\Manage.ps1') -Action Start | Out-Null
$ports = @($config.gatewayPort)
if ($config.upstreamMode -eq 'managed') { $ports += $config.upstreamPort }
$deadline = [DateTime]::UtcNow.AddSeconds(120)
$announced = $false
do {
    $ready = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -in $ports })
    if (@($ready.LocalPort | Sort-Object -Unique).Count -eq $ports.Count) { break }
    if (-not $announced) {
        [Console]::Error.WriteLine('Waiting for the local services. Complete Microsoft sign-in in Chrome if it opened.')
        $announced = $true
    }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)
if (@($ready.LocalPort | Sort-Object -Unique).Count -ne $ports.Count) {
    throw 'Services are not ready. Complete Microsoft sign-in and inspect .local/logs, then launch again.'
}

$mcpPath = Join-Path $dataDir 'mcp.json'
$environment = @{
    ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + $config.gatewayPort
    ANTHROPIC_AUTH_TOKEN = (Get-Content -LiteralPath (Join-Path $dataDir 'gateway-key.txt') -Raw).Trim()
    ANTHROPIC_API_KEY = $null
    ANTHROPIC_MODEL = $null
    ANTHROPIC_CUSTOM_HEADERS = $null
    ANTHROPIC_DEFAULT_MODEL = $catalog.default
    ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet'
    ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus'
    ANTHROPIC_DEFAULT_HAIKU_MODEL = $catalog.helper
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = 'M365 helper (Claude Sonnet)'
    ANTHROPIC_DEFAULT_FABLE_MODEL = $null
    ANTHROPIC_SMALL_FAST_MODEL = $null
    ANTHROPIC_CUSTOM_MODEL_OPTION = $null
    CLAUDE_CODE_OAUTH_TOKEN = $null
    CLAUDE_CODE_USE_BEDROCK = $null
    CLAUDE_CODE_USE_VERTEX = $null
    CLAUDE_CODE_USE_FOUNDRY = $null
    CLAUDE_CODE_SUBAGENT_MODEL = $null
    CLAUDE_CONFIG_DIR = (Join-Path $dataDir 'claude')
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
    ENABLE_TOOL_SEARCH = 'true'
    API_TIMEOUT_MS = $config.timeoutMs.ToString()
}
$previousEnvironment = @{}
$originalDirectory = Get-Location
$exitCode = 1
try {
    foreach ($name in $environment.Keys) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
    }
    if ($options.Directory) { Set-Location -LiteralPath $options.Directory }
    $clientSettings = New-M365ClientSettings -DataDirectory $dataDir -Environment $environment -Arguments $nativeArguments
    $nativeArguments = $clientSettings.NativeArguments
    $prompt = Get-Content -LiteralPath (Join-Path $repoRoot 'prompts\agent.md') -Raw
    $prompt += [Environment]::NewLine + 'Working directory: ' + (Get-Location).Path
    $launchArguments = @('--settings', $clientSettings.Path, '--tools', $options.BuiltInTools, '--system-prompt', $prompt)
    if ($options.ModelSpecified) {
        $selected = $catalog.models | Where-Object id -EQ $options.Model
        $launchArguments += @('--model', ($selected.clientModel ?? $selected.id))
    }
    if (-not $options.NoMcp) { $launchArguments += @('--mcp-config', $mcpPath) }
    # Terminates the variadic --mcp-config option before native positional input.
    $launchArguments += '--strict-mcp-config'
    $modelLabel = if ($options.ModelSpecified) { $options.Model } else { 'saved selection or ' + $catalog.default }
    [Console]::Error.WriteLine('M365 Claude Code | preferred route: ' + $modelLabel + ' | gateway: ' + $config.gatewayPort)
    if ($clientSettings.NativeFallback) {
        [Console]::Error.WriteLine('Fallback policy: the explicitly supplied native --fallback-model option.')
    } elseif ($config.fallbackEnabled -eq $false) {
        [Console]::Error.WriteLine('Fallback policy: disabled by local configuration.')
    } else {
        [Console]::Error.WriteLine('Fallback policy: other configured Claude routes before GPT. The response model identifies the route that answered.')
    }
    & $claude @launchArguments @nativeArguments
    $exitCode = $LASTEXITCODE
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    Set-Location -LiteralPath $originalDirectory.Path
}
exit $exitCode
