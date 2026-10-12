param(
    [switch]$Install,
    [string]$HomeDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CRAP'),
    [string]$ProfilePath = $PROFILE.CurrentUserCurrentHost,
    [string]$ClaudePath
)

# CRAP shell integration. No changes to Claude's configuration or history directory.
function Set-CrapPrivateDirectory([string]$Path) {
    [void][IO.Directory]::CreateDirectory($Path)
    $acl = Get-Acl -LiteralPath $Path
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rules = @($acl.Access)
    if ($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and
        $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and
        $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq 'FullControl') { return }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($entry in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($entry) }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}
function Write-CrapText([string]$Path, [string]$Value) {
    $temp = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temp, $Value, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temp -Destination $Path -Force -ErrorAction Stop
}
function Get-CrapClaudeDirectory { Join-Path $global:CrapShellHome 'clients/claude' }
function Get-CrapMode {
    $file = Join-Path (Get-CrapClaudeDirectory) 'mode'
    if (Test-Path -LiteralPath $file) { return [IO.File]::ReadAllText($file).Trim() }
    return 'direct'
}
function Test-CrapEndpoint([string]$Value) {
    $url = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$url)) { return $false }
    return (($url.Scheme -eq 'https' -or ($url.Scheme -eq 'http' -and $url.Host -in @('localhost', '127.0.0.1', '[::1]'))) -and
        -not $url.UserInfo -and -not $url.Query -and -not $url.Fragment -and $url.AbsolutePath -eq '/')
}
function Set-CrapClaudeConnection {
    $dir = Get-CrapClaudeDirectory
    $endpoint = (Read-Host 'Claude API origin (no /v1)').Trim().TrimEnd('/')
    if (-not (Test-CrapEndpoint $endpoint)) { throw 'Use an HTTPS origin, or loopback HTTP, without /v1, credentials or query parameters.' }
    $secret = Read-Host 'CRAP client API key (input hidden)' -AsSecureString
    if ($secret.Length -eq 0) { throw 'A client API key is required.' }
    # Export-Clixml encrypts SecureString for this Windows user and machine.
    $secret | Export-Clixml -LiteralPath (Join-Path $dir 'key.xml') -ErrorAction Stop
    Write-CrapText (Join-Path $dir 'endpoint') $endpoint
    Write-Host 'Connection saved. Select proxy mode when ready.'
}
function Complete-CrapEnrollment([string]$PanelOrigin, [string]$Ticket, [string]$Mode, [bool]$Cleanup, [string]$InstallerPath) {
    if (-not (Test-CrapEndpoint $PanelOrigin)) { throw 'Invalid enrollment address.' }
    try {
        $response = Invoke-RestMethod -Uri ($PanelOrigin + '/client-setup/redeem') -Method Post -Body $Ticket -ContentType 'text/plain' -MaximumRedirection 0 -ErrorAction Stop
        $parts = ([string]$response).TrimEnd("`n") -split "`n"
        if ($parts.Count -ne 3 -or $parts[0] -ne 'CRAP-ENROLLMENT-1' -or -not (Test-CrapEndpoint $parts[1]) -or $parts[2] -notmatch '^crap-[a-f0-9]{48}$') { throw 'Invalid setup response.' }
        $dir = Get-CrapClaudeDirectory
        # A partial save must never send a new key to a previously configured origin.
        Write-CrapText (Join-Path $dir 'mode') 'direct'
        ConvertTo-SecureString $parts[2] -AsPlainText -Force | Export-Clixml -LiteralPath (Join-Path $dir 'key.xml') -ErrorAction Stop
        Write-CrapText (Join-Path $dir 'endpoint') $parts[1]
        Set-CrapMode 'claude' $Mode
    } catch {
        throw 'Automatic setup failed. Check Tailscale and the 15-minute expiry. If the ticket was consumed, remove this device in Client API Keys and download a new installer. No credentials were printed.'
    } finally { $Ticket = $null; $parts = $null; $response = $null }
    Write-Host 'Proxy connection configured. Keep using claude; use crap to switch modes.'
    if ($Cleanup -and [IO.Path]::GetFullPath($InstallerPath) -ne [IO.Path]::GetFullPath((Join-Path $global:CrapShellHome 'shell.ps1'))) {
        try { Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction Stop }
        catch { Write-Host 'Setup succeeded. You can delete the downloaded installer manually.' }
    }
    if (-not [Console]::IsInputRedirected) { Invoke-CrapMenu }
}
function Set-CrapMode([string]$Client, [string]$Mode) {
    if ($Client -ne 'claude' -or $Mode -notin @('direct', 'proxy')) { throw 'Supported: crap use claude direct|proxy' }
    $dir = Get-CrapClaudeDirectory
    if ($Mode -eq 'proxy' -and (-not (Test-Path -LiteralPath (Join-Path $dir 'endpoint')) -or -not (Test-Path -LiteralPath (Join-Path $dir 'key.xml')))) {
        throw 'Configure the Claude proxy connection first: crap configure claude'
    }
    Write-CrapText (Join-Path $dir 'mode') $Mode
    Write-Host "Claude Code: $Mode. Applies to new launches; keep using claude."
}
function Get-CrapSecret {
    $secret = Import-Clixml -LiteralPath (Join-Path (Get-CrapClaudeDirectory) 'key.xml')
    if ($secret -isnot [Security.SecureString]) { throw 'Invalid credential file. Configure the connection again.' }
    return (New-Object Management.Automation.PSCredential('crap', $secret)).GetNetworkCredential().Password
}
function Show-CrapStatus {
    Write-Host "Claude Code: $(Get-CrapMode) (supported)"
    foreach ($client in @('codex', 'gemini')) {
        $found = [bool](Get-Command $client -CommandType Application,ExternalScript -ErrorAction SilentlyContinue)
        Write-Host "$client`: installed=$found; adapter not supported yet"
    }
    $file = Join-Path (Get-CrapClaudeDirectory) 'endpoint'
    if (Test-Path -LiteralPath $file) { Write-Host "Proxy: $([IO.File]::ReadAllText($file))" }
    Write-Host 'History: existing Claude profile. Direct mode preserves your original Claude environment and login.'
}
function Test-CrapConnection {
    $endpoint = [IO.File]::ReadAllText((Join-Path (Get-CrapClaudeDirectory) 'endpoint'))
    if (-not (Test-CrapEndpoint $endpoint)) { throw 'Invalid saved endpoint.' }
    try {
        $models = Invoke-RestMethod -Uri ($endpoint + '/v1/models') -Headers @{ Authorization = ('Bearer ' + (Get-CrapSecret)) } -MaximumRedirection 0 -ErrorAction Stop
        if ($null -eq $models.data) { throw 'Unexpected response' }
        Write-Host "Proxy authenticated. $(@($models.data).Count) models available. No inference request sent."
    } catch { throw 'Proxy check failed. Check the client key, endpoint, and Tailscale connection. No key was printed.' }
}
function Invoke-CrapClaude {
    $dir = Get-CrapClaudeDirectory
    $executable = [IO.File]::ReadAllText((Join-Path $dir 'executable'))
    if (-not (Test-Path -LiteralPath $executable)) { throw 'Claude executable moved. Reinstall the CRAP shell integration.' }
    $mode = Get-CrapMode
    if ($mode -eq 'direct') { & $executable @args; return }
    if ($mode -ne 'proxy') { throw 'Invalid mode. Use crap use claude direct|proxy.' }
    foreach ($argument in $args) {
        if ($argument -match '^--(settings|setting-sources)(=|$)') { throw 'Proxy mode reserves --settings. Use direct mode for custom settings files.' }
    }
    $managed = Join-Path $env:ProgramFiles 'ClaudeCode/managed-settings.json'
    if (Test-Path -LiteralPath $managed) { throw 'Managed Claude settings detected. Ask your administrator to configure proxy routing; CRAP will not override them.' }
    $endpoint = [IO.File]::ReadAllText((Join-Path $dir 'endpoint'))
    if (-not (Test-CrapEndpoint $endpoint)) { throw 'Invalid saved endpoint.' }
    $overrides = @{
        ANTHROPIC_BASE_URL = $endpoint; ANTHROPIC_AUTH_TOKEN = (Get-CrapSecret); ANTHROPIC_API_KEY = ''
        CLAUDE_CODE_OAUTH_TOKEN = ''; CLAUDE_CODE_USE_BEDROCK = ''; CLAUDE_CODE_USE_VERTEX = ''; CLAUDE_CODE_USE_FOUNDRY = ''
    }
    $original = @{}
    $settingsFile = Join-Path $dir ('session-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        # CLI settings take precedence over project/user env entries. Managed policy still wins.
        Write-CrapText $settingsFile (@{ env = $overrides } | ConvertTo-Json -Depth 4 -Compress)
        foreach ($name in $overrides.Keys) {
            $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $overrides[$name], 'Process')
        }
        & $executable --settings $settingsFile @args
    } finally {
        foreach ($name in $original.Keys) { [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process') }
        Remove-Item -LiteralPath $settingsFile -Force -ErrorAction SilentlyContinue
    }
}
function Remove-CrapIntegration {
    $profileFile = [IO.File]::ReadAllText((Join-Path $global:CrapShellHome 'profile'))
    $loader = [IO.File]::ReadAllText((Join-Path $global:CrapShellHome 'loader'))
    if (Test-Path -LiteralPath $profileFile) {
        $text = [IO.File]::ReadAllText($profileFile)
        $lines = $text -split '\r?\n' | Where-Object { $_ -ne $loader }
        Write-CrapText $profileFile ($lines -join [Environment]::NewLine)
    }
    Write-CrapText (Join-Path (Get-CrapClaudeDirectory) 'mode') 'direct'
    foreach ($name in @('key.xml', 'endpoint')) {
        Remove-Item -LiteralPath (Join-Path (Get-CrapClaudeDirectory) $name) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item Function:\claude, Function:\crap -ErrorAction SilentlyContinue
    Write-Host 'Shell loader and proxy credentials removed. Claude files untouched. Other open shells need restarting.'
}
function Invoke-CrapMenu {
    param([string]$Action, [string]$Client = 'claude', [string]$Mode)
    if ($Action) {
        switch ($Action) {
            'status' { Show-CrapStatus }
            'use' { Set-CrapMode $Client $Mode }
            'configure' { if ($Client -ne 'claude') { throw 'This client adapter is not supported yet.' }; Set-CrapClaudeConnection }
            'doctor' { Test-CrapConnection }
            'uninstall' { if ((Read-Host 'Remove CRAP integration and its saved proxy key? Type REMOVE') -ceq 'REMOVE') { Remove-CrapIntegration } }
            default { Write-Host 'crap [status | configure claude | use claude direct|proxy | doctor | uninstall]' }
        }
        return
    }
    if ([Console]::IsInputRedirected) { throw 'The menu needs an interactive terminal. Use crap status or crap use claude direct|proxy.' }
    do {
        Write-Host "`nCRAP - Client connections"
        Show-CrapStatus
        Write-Host "`n1. Claude: use proxy`n2. Claude: use direct`n3. Configure Claude connection`n4. Check proxy connection`n5. Remove integration`n0. Exit"
        $choice = Read-Host 'Choose'
        try {
            switch ($choice) {
                '1' { Set-CrapMode 'claude' 'proxy' }
                '2' { Set-CrapMode 'claude' 'direct' }
                '3' { Set-CrapClaudeConnection }
                '4' { Test-CrapConnection }
                '5' { Invoke-CrapMenu 'uninstall'; return }
                '0' { return }
            }
        } catch { Write-Host $_.Exception.Message -ForegroundColor Yellow }
    } while ($true)
}

if ($env:OS -ne 'Windows_NT') { throw 'Use the Bash/Zsh installer on macOS or Linux.' }
foreach ($name in @('claude', 'crap')) {
    $existing = Get-Command $name -CommandType Alias,Function -ErrorAction SilentlyContinue
    if ($existing -and $existing.Definition -notmatch 'Invoke-Crap(Claude|Menu)') {
        throw "An existing $name alias/function was found. It has not been changed. Resolve that conflict before loading CRAP."
    }
}
if ($Install) {
    if (-not $ClaudePath) { $ClaudePath = (Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    $ClaudePath = (Resolve-Path -LiteralPath $ClaudePath -ErrorAction Stop).Path
    Set-CrapPrivateDirectory $HomeDirectory
    Set-CrapPrivateDirectory (Join-Path $HomeDirectory 'clients/claude')
    $destination = Join-Path $HomeDirectory 'shell.ps1'
    $loader = ". '" + $destination.Replace("'", "''") + "' -HomeDirectory '" + $HomeDirectory.Replace("'", "''") + "' # CRAP shell integration"
    if ((Test-Path -LiteralPath (Join-Path $HomeDirectory 'profile')) -and [IO.File]::ReadAllText((Join-Path $HomeDirectory 'profile')) -ne $ProfilePath) { throw 'CRAP is installed for a different PowerShell profile. Uninstall there before moving it.' }
    $content = if (Test-Path -LiteralPath $ProfilePath) { [IO.File]::ReadAllText($ProfilePath) } else { '' }
    if ($content.Contains('# CRAP shell integration') -and -not $content.Contains($loader)) { throw 'A different CRAP loader already exists. Resolve it before installing.' }
    if ([IO.Path]::GetFullPath($PSCommandPath) -ne [IO.Path]::GetFullPath($destination)) {
        # Never persist the personalized one-use ticket in the shell profile's loaded script.
        $scriptText = [IO.File]::ReadAllText($PSCommandPath)
        Write-CrapText $destination (($scriptText -split '(?m)^# CRAP enrollment payload', 2)[0])
    }
    Write-CrapText (Join-Path $HomeDirectory 'clients/claude/executable') $ClaudePath
    if (-not (Test-Path -LiteralPath (Join-Path $HomeDirectory 'clients/claude/mode'))) { Write-CrapText (Join-Path $HomeDirectory 'clients/claude/mode') 'direct' }
    Write-CrapText (Join-Path $HomeDirectory 'profile') $ProfilePath
    Write-CrapText (Join-Path $HomeDirectory 'loader') $loader
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $ProfilePath))
    if (-not $content.Contains($loader)) {
        if (Test-Path -LiteralPath $ProfilePath) { Copy-Item -LiteralPath $ProfilePath -Destination (Join-Path $HomeDirectory ('profile-backup-' + [guid]::NewGuid().ToString('N'))) }
        Write-CrapText $ProfilePath ($content + [Environment]::NewLine + $loader + [Environment]::NewLine)
    }
    Write-Host 'Installed. Run crap to configure a client. New PowerShell sessions load it automatically.'
}
$global:CrapShellHome = $HomeDirectory
function global:claude { Invoke-CrapClaude @args }
function global:crap { Invoke-CrapMenu @args }
