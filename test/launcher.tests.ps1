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

$repoRoot = Get-M365RepositoryRoot
$parseTokens = $null
$parseErrors = $null
foreach ($file in @('m365-claude.ps1','scripts/Common.ps1','scripts/Setup.ps1','scripts/Manage.ps1','scripts/Doctor.ps1')) {
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $repoRoot $file), [ref]$parseTokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ('PowerShell syntax error in ' + $file + ': ' + ($parseErrors.Message -join '; ')) }
}
Write-Output 'PASS: all PowerShell entry points parse'
