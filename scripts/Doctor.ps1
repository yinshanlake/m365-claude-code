#Requires -Version 7.4
[CmdletBinding()]
param([switch]$Live, [switch]$CheckContext, [string]$Model = 'claude-sonnet')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$config = Read-M365Configuration
$dataDir = Get-M365DataDirectory
$baseUrl = 'http://127.0.0.1:' + $config.gatewayPort
$key = (Get-Content -LiteralPath (Join-Path $dataDir 'gateway-key.txt') -Raw).Trim()
$headers = @{ Authorization = 'Bearer ' + $key }
& (Join-Path $PSScriptRoot 'Manage.ps1') -Action Status | Format-Table -AutoSize
$health = Invoke-RestMethod -Uri ($baseUrl + '/health') -TimeoutSec 5
if ($health.status -ne 'ok') { throw 'The gateway health check failed.' }
$catalog = Invoke-RestMethod -Uri ($baseUrl + '/v1/models') -Headers $headers -TimeoutSec 5
Write-Output ('Gateway ready; configured routes: ' + ($catalog.data.id -join ', '))

$upstreamHeaders = @{}
$upstreamKeyPath = Join-Path $dataDir 'upstream-key.txt'
$upstreamKey = if ($env:M365_UPSTREAM_API_KEY) { $env:M365_UPSTREAM_API_KEY } elseif (Test-Path -LiteralPath $upstreamKeyPath) { (Get-Content -LiteralPath $upstreamKeyPath -Raw).Trim() } else { $null }
if ($upstreamKey) { $upstreamHeaders.Authorization = 'Bearer ' + $upstreamKey }
$upstream = Invoke-RestMethod -Uri ($config.upstreamBaseUrl + '/models') -Headers $upstreamHeaders -TimeoutSec 10
$missing = @($catalog.data.id | Where-Object { $_ -notin $upstream.data.id })
if ($missing.Count) { Write-Warning ('These routes were not advertised upstream: ' + ($missing -join ', ')) }
else { Write-Output 'All configured routes are advertised by the upstream proxy.' }

if ($CheckContext) {
    $nonce = [Guid]::NewGuid().ToString('N')
    $session = 'context-check-' + [Guid]::NewGuid().ToString('N')
    $messages = @(@{ role = 'user'; content = "Remember this code for the next turn: $nonce. Reply exactly READY." })
    $contexts = @()
    for ($turn = 0; $turn -lt 2; $turn++) {
        $body = @{ model = $Model; max_tokens = 64; stream = $false;
            metadata = @{ user_id = $session }; messages = $messages } | ConvertTo-Json -Depth 10
        $result = Invoke-RestMethod -Uri ($baseUrl + '/v1/messages') -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 240 -ResponseHeadersVariable responseHeaders
        $contextHeader = @($responseHeaders['x-m365-context'])[0]
        if (-not $contextHeader) { throw 'The upstream did not report context reuse. This check requires the pinned backend patch.' }
        $contexts += $contextHeader | ConvertFrom-Json
        $answer = (($result.content | Where-Object type -EQ text).text -join [Environment]::NewLine)
        if ($turn -eq 0) {
            $messages += @{ role = 'assistant'; content = $result.content }
            $messages += @{ role = 'user'; content = 'Reply with only the code from the previous user message.' }
        } elseif (-not $answer.Contains($nonce)) {
            throw 'The upstream reused its conversation but did not recall the test code.'
        }
    }
    if (-not $contexts[1].conversation_reused -or $contexts[1].initial_mode -ne 'delta' -or
        $contexts[0].conversation_hash -ne $contexts[1].conversation_hash) {
        throw 'The two requests did not reuse the same M365 conversation.'
    }
    Write-Output ('Context reuse confirmed: ' + $contexts[1].reused_messages + ' earlier messages retained; text submitted: ' +
        $contexts[0].submitted_characters + ' -> ' + $contexts[1].submitted_characters + ' characters.')
    Write-Output 'The second response recalled the first-turn code. Two inference requests were made.'
    Write-Output 'Provider prompt-cache counters are unreported. Context reuse does not remove per-turn allowance charges.'
} elseif ($Live) {
    $body = @{ model = $Model; max_tokens = 64; stream = $false;
        messages = @(@{ role = 'user'; content = 'Reply exactly M365_GATEWAY_OK.' }) } | ConvertTo-Json -Depth 5
    $result = Invoke-RestMethod -Uri ($baseUrl + '/v1/messages') -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 240
    Write-Output ('Live route: ' + $result.model)
    Write-Output (($result.content | Where-Object type -EQ text).text -join [Environment]::NewLine)
    Write-Output 'This verifies a chat request. Verify actual tool execution separately.'
} else {
    Write-Output 'No inference was requested. Add -Live for one response, or -CheckContext for a two-turn context reuse check.'
}
