#Requires -Version 7.4

function New-M365ClientSettings {
    param([string]$DataDirectory, [hashtable]$Environment, [string[]]$Arguments)
    $forwarded = [Collections.Generic.List[string]]::new()
    $settingsSpec = $null
    $nativeFallback = $false
    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $argument = $Arguments[$index]
        if ($argument -ceq '--') {
            for (; $index -lt $Arguments.Count; $index++) { $forwarded.Add($Arguments[$index]) }
            break
        }
        if ($argument -ceq '--settings') {
            $index++
            if ($index -ge $Arguments.Count) { throw 'Missing value for --settings.' }
            $settingsSpec = $Arguments[$index]
        } elseif ($argument.StartsWith('--settings=', [StringComparison]::Ordinal)) {
            $settingsSpec = $argument.Substring('--settings='.Length)
        } else {
            if ($argument -cmatch '^--fallback-model(?:=|$)') { $nativeFallback = $true }
            $forwarded.Add($argument)
        }
    }
    $settings = @{}
    if ($null -ne $settingsSpec) {
        $raw = if ($settingsSpec.TrimStart().StartsWith('{')) { $settingsSpec } else { Get-Content -LiteralPath $settingsSpec -Raw }
        $settings = $raw | ConvertFrom-Json -AsHashtable
        if ($settings -isnot [System.Collections.IDictionary]) { throw '--settings must contain a JSON object.' }
    }
    if (-not $settings.Contains('env')) { $settings.env = @{} }
    if ($settings.env -isnot [System.Collections.IDictionary]) { throw 'The settings env field must be a JSON object.' }
    foreach ($name in $Environment.Keys) {
        $settings.env[$name] = if ($null -eq $Environment[$name]) { '' } else { [string]$Environment[$name] }
    }
    if ($nativeFallback) { $settings.env.ANTHROPIC_CUSTOM_HEADERS = 'x-m365-fallback: off' }
    # A private per-launch file prevents project env settings from rerouting the
    # client. Retain it because native background sessions can outlive this launcher.
    $directory = Join-Path $DataDirectory 'launch-settings'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $settingsPath = Join-Path $directory ([Guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
    return @{ Path = $settingsPath; NativeArguments = $forwarded.ToArray(); NativeFallback = $nativeFallback }
}
