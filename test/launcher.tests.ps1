#Requires -Version 7.4
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\Common.ps1')

function Assert-Equal {
    param($Actual, $Expected, [string]$Label)
    if (($Actual | ConvertTo-Json -Compress -Depth 8) -cne ($Expected | ConvertTo-Json -Compress -Depth 8)) {
        throw ('FAILED: ' + $Label)
    }
    Write-Output ('PASS: ' + $Label)
}

$native = @('--verbose', '--debug', 'api', '--print', '--output-format', 'stream-json', 'a prompt with spaces')
Assert-Equal (ConvertTo-M365LaunchOptions -Arguments $native).NativeArguments $native 'native flags and prompt remain in order'
$options = ConvertTo-M365LaunchOptions -Arguments @('-Model', 'claude-sonnet', '-NoMcp', '-BuiltInTools', 'Read,Bash', '--continue')
Assert-Equal $options.Model 'claude-sonnet' 'wrapper model is parsed'
Assert-Equal $options.NoMcp $true 'wrapper MCP option is parsed'
Assert-Equal $options.NativeArguments @('--continue') 'only wrapper options are consumed'
$terminated = @('--', '-Model', 'literal prompt')
Assert-Equal (ConvertTo-M365LaunchOptions -Arguments $terminated).NativeArguments $terminated 'native end-of-options marker is honored'

$testDirectory = Join-Path (Get-M365RepositoryRoot) ('.local\launcher-tests\' + [Guid]::NewGuid().ToString('N'))
$connectionEnvironment = @{ ANTHROPIC_BASE_URL = 'http://127.0.0.1:4145'; ANTHROPIC_AUTH_TOKEN = 'local-test-only'; ANTHROPIC_API_KEY = $null; ANTHROPIC_MODEL = $null }
$inline = '{"theme":"light","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:23333","CUSTOM_TEST_VALUE":"keep"},"permissions":{"allow":["Read"]}}'
$launch = New-M365ClientSettings -DataDirectory $testDirectory -Environment $connectionEnvironment -Arguments @('--verbose','--settings',$inline,'--','--settings','literal prompt')
$settings = Get-Content -LiteralPath $launch.Path -Raw | ConvertFrom-Json -AsHashtable
Assert-Equal $settings.env.ANTHROPIC_BASE_URL 'http://127.0.0.1:4145' 'connection overrides a competing settings endpoint'
Assert-Equal $settings.env.ANTHROPIC_AUTH_TOKEN 'local-test-only' 'the gateway credential is pinned in private settings'
Assert-Equal $settings.env.ANTHROPIC_API_KEY '' 'competing authentication is cleared'
Assert-Equal $settings.env.CUSTOM_TEST_VALUE 'keep' 'unrelated environment settings are retained'
Assert-Equal $settings.permissions.allow @('Read') 'native permission settings are retained'
Assert-Equal $launch.NativeArguments @('--verbose','--','--settings','literal prompt') 'settings parsing respects the native argument delimiter'
$second = New-M365ClientSettings -DataDirectory $testDirectory -Environment $connectionEnvironment -Arguments @('--settings',$launch.Path)
if ($second.Path -eq $launch.Path) { throw 'Launch settings must be isolated per client session.' }
Write-Output 'PASS: launch settings remain available independently for background clients'
$explicitFallback = New-M365ClientSettings -DataDirectory $testDirectory -Environment $connectionEnvironment -Arguments @('--fallback-model','claude-sonnet')
Assert-Equal (Get-Content -LiteralPath $explicitFallback.Path -Raw | ConvertFrom-Json).env.ANTHROPIC_CUSTOM_HEADERS 'x-m365-fallback: off' 'explicit native fallback disables gateway fallback'
$literalFallback = New-M365ClientSettings -DataDirectory $testDirectory -Environment $connectionEnvironment -Arguments @('--','--fallback-model')
Assert-Equal $literalFallback.NativeFallback $false 'a literal prompt cannot change fallback policy'

$repoRoot = Get-M365RepositoryRoot
$parseTokens = $null
$parseErrors = $null
foreach ($file in @('m365-claude.ps1','scripts/Common.ps1','scripts/Client.ps1','scripts/Setup.ps1','scripts/Manage.ps1','scripts/Doctor.ps1')) {
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $repoRoot $file), [ref]$parseTokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ('PowerShell syntax error in ' + $file + ': ' + ($parseErrors.Message -join '; ')) }
}
Write-Output 'PASS: all PowerShell entry points parse'
