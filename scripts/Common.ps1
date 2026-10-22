#Requires -Version 7.4
$script:M365RepositoryRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Client.ps1')

function Get-M365RepositoryRoot { $script:M365RepositoryRoot }

function Get-M365DataDirectory {
    if ($env:M365_CLAUDE_DATA_DIR) { return [IO.Path]::GetFullPath($env:M365_CLAUDE_DATA_DIR) }
    Join-Path (Get-M365RepositoryRoot) '.local'
}

function Read-M365Configuration {
    $path = Join-Path (Get-M365DataDirectory) 'config.json'
    if (-not (Test-Path -LiteralPath $path)) { throw 'Run scripts/Setup.ps1 first.' }
    Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
}

function Write-M365Json {
    param([string]$Path, [object]$Value)
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}

function Invoke-M365Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('Command failed: ' + [IO.Path]::GetFileName($Program) + ' (exit ' + $LASTEXITCODE + ').') }
}

function Find-M365Application {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    return $null
}

function Protect-M365DataDirectory {
    param([string]$Path)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    if ($IsWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $systemIdentity = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        foreach ($principal in @($identity, $systemIdentity)) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $principal, [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance, [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
}

function ConvertTo-M365LaunchOptions {
    param([string[]]$Arguments)
    $options = @{ Model = $null; ModelSpecified = $false; NoMcp = $false; Directory = $null; BuiltInTools = 'default' }
    $native = [Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $argument = $Arguments[$index]
        if ($argument -eq '--') {
            for (; $index -lt $Arguments.Count; $index++) { $native.Add($Arguments[$index]) }
            break
        }
        if ($argument -eq '-NoMcp') { $options.NoMcp = $true; continue }
        if ($argument -in @('-Model', '-Directory', '-BuiltInTools')) {
            $index++
            if ($index -ge $Arguments.Count) { throw ('Missing value for ' + $argument) }
            switch ($argument) {
                '-Model' { $options.Model = $Arguments[$index]; $options.ModelSpecified = $true }
                '-Directory' { $options.Directory = $Arguments[$index] }
                '-BuiltInTools' { $options.BuiltInTools = $Arguments[$index] }
            }
        } else { $native.Add($argument) }
    }
    $options.NativeArguments = $native.ToArray()
    return $options
}
