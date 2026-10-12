param([string]$TestRoot)
$ErrorActionPreference = 'Stop'
$sourceFile = Join-Path $PSScriptRoot 'crap.ps1'
$fixture = Join-Path $TestRoot ([guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
$profileFile = Join-Path $fixture 'profile.ps1'
$crapFixture = Join-Path $fixture 'state'
$fakeClaude = Join-Path $fixture 'fake-claude.ps1'
$env:CRAP_TEST_OUTPUT = Join-Path $fixture 'launch.json'
[IO.File]::WriteAllText($profileFile, '# existing profile content')
[IO.File]::WriteAllText($fakeClaude, @'
$overlay = $null
if ($args.Count -ge 2 -and $args[0] -eq '--settings') { $overlay = Get-Content -Raw -LiteralPath $args[1] | ConvertFrom-Json }
@{ args = @($args); cwd = (Get-Location).Path; config = $env:CLAUDE_CONFIG_DIR; token = $env:ANTHROPIC_AUTH_TOKEN; base = $env:ANTHROPIC_BASE_URL; overlay = $overlay } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:CRAP_TEST_OUTPUT
exit 23
'@)
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
. $sourceFile -Install -HomeDirectory $crapFixture -ProfilePath $profileFile -ClaudePath $fakeClaude
. $sourceFile -Install -HomeDirectory $crapFixture -ProfilePath $profileFile -ClaudePath $fakeClaude
$profileText = [IO.File]::ReadAllText($profileFile)
Assert (($profileText | Select-String '# CRAP shell integration' -AllMatches).Matches.Count -eq 1) 'Duplicate loader'
Assert ($profileText.Contains('# existing profile content')) 'Profile clobbered'
$env:CLAUDE_CONFIG_DIR = Join-Path $fixture 'original-history'
$env:ANTHROPIC_AUTH_TOKEN = 'original-token'
$env:ANTHROPIC_BASE_URL = 'https://original.example'
$before = (Get-Location).Path
claude '--continue' 'two words' '--resume' 'session-id'
Assert ($LASTEXITCODE -eq 23) 'Direct exit code lost'
$launch = Get-Content -Raw $env:CRAP_TEST_OUTPUT | ConvertFrom-Json
Assert ($launch.args[1] -eq 'two words' -and $launch.args.Count -eq 4) 'Direct arguments changed'
Assert ($launch.token -eq 'original-token' -and $launch.base -eq 'https://original.example') 'Direct environment changed'
$dir = Get-CrapClaudeDirectory
Write-CrapText (Join-Path $dir 'endpoint') 'https://proxy.example'
ConvertTo-SecureString 'fixture-client-key' -AsPlainText -Force | Export-Clixml -LiteralPath (Join-Path $dir 'key.xml')
Set-CrapMode 'claude' 'proxy'
claude '--continue' 'two words'
Assert ($LASTEXITCODE -eq 23) 'Proxy exit code lost'
$launch = Get-Content -Raw $env:CRAP_TEST_OUTPUT | ConvertFrom-Json
Assert ($launch.args[0] -eq '--settings' -and $launch.args[3] -eq 'two words') 'Proxy arguments changed'
Assert ($launch.overlay.env.ANTHROPIC_BASE_URL -eq 'https://proxy.example') 'Overlay missing endpoint'
Assert ($launch.token -eq 'fixture-client-key') 'Proxy token missing'
Assert ($launch.config -eq $env:CLAUDE_CONFIG_DIR -and $launch.cwd -eq $before) 'History or working directory changed'
Assert ($env:ANTHROPIC_AUTH_TOKEN -eq 'original-token' -and $env:ANTHROPIC_BASE_URL -eq 'https://original.example') 'Parent environment not restored'
Assert (@(Get-ChildItem -LiteralPath $dir -Filter 'session-*.json').Count -eq 0) 'Session credential file leaked'
Assert (-not ([IO.File]::ReadAllText((Join-Path $dir 'key.xml')).Contains('fixture-client-key'))) 'Key stored unencrypted'
$blocked = $false
try { claude --settings another.json } catch { $blocked = $true }
Assert $blocked 'Proxy accepted conflicting settings'
# Exercise the personalized download against a stub enrollment endpoint.
$personalized = Join-Path $fixture 'download.ps1'
$ticketFixture = 'a' * 64
$keyFixture = 'crap-' + ('b' * 48)
function Invoke-RestMethod {
    param($Uri, $Method, $Body, $ContentType, $MaximumRedirection, $ErrorAction)
    Assert ($Body -eq $ticketFixture) 'Ticket was not sent in the request body'
    Assert ($MaximumRedirection -eq 0) 'Enrollment followed redirects'
    return "CRAP-ENROLLMENT-1`nhttps://configured.example`n$keyFixture`n"
}
$personalizedText = [IO.File]::ReadAllText($sourceFile) + "`n# CRAP enrollment payload`nif (`$Install) { Complete-CrapEnrollment 'https://panel.example' '$ticketFixture' 'proxy' `$true `$PSCommandPath }`n"
[IO.File]::WriteAllText($personalized, $personalizedText)
. $personalized -Install -HomeDirectory $crapFixture -ProfilePath $profileFile -ClaudePath $fakeClaude
Assert (-not (Test-Path -LiteralPath $personalized)) 'Successful installer not cleaned up'
Assert ((Get-CrapSecret) -eq $keyFixture) 'Enrolled key not saved'
Assert ((Get-CrapMode) -eq 'proxy') 'Selected initial mode lost'
Assert (-not ([IO.File]::ReadAllText((Join-Path $crapFixture 'shell.ps1')).Contains($ticketFixture))) 'Ticket persisted in installed script'
function Invoke-RestMethod { throw 'fixture-private-error' }
[IO.File]::WriteAllText($personalized, $personalizedText)
$blocked = $false
try { . $personalized -Install -HomeDirectory $crapFixture -ProfilePath $profileFile -ClaudePath $fakeClaude } catch { $blocked = $true; Assert (-not $_.Exception.Message.Contains('fixture-private-error')) 'Raw error leaked' }
Assert $blocked 'Failed redemption was accepted'
Assert (Test-Path -LiteralPath $personalized) 'Failed installer was deleted'
$lanId = '00000000-0000-4000-8000-000000000001'
function Invoke-RestMethod {
    param($Uri, $TimeoutSec, $MaximumRedirection, $ErrorAction, $Body, $Method, $ContentType)
    if ($Uri -like '*/redeem') { return "CRAP-ENROLLMENT-2`nhttps://fallback.example`n$keyFixture`nhttps://lan.example`nhttps://lan.example`n$lanId`n" }
    Assert ($null -eq $Body -and $MaximumRedirection -eq 0 -and $TimeoutSec -eq 2) 'Probe must be bounded and contain no credentials'
    return "CRAP-LAN-1:$lanId`n"
}
Complete-CrapEnrollment 'https://panel.example' $ticketFixture 'proxy' $false $personalized
Assert ((Resolve-CrapEndpoint) -eq 'https://lan.example') 'LAN not preferred'
claude '--continue'
$launch = Get-Content -Raw $env:CRAP_TEST_OUTPUT | ConvertFrom-Json
Assert ($launch.overlay.env.ANTHROPIC_BASE_URL -eq 'https://lan.example') 'Launch did not use selected LAN endpoint'
function Invoke-RestMethod { return 'CRAP-LAN-1:wrong-workspace' }
Assert ((Resolve-CrapEndpoint) -eq 'https://fallback.example') 'Wrong workspace accepted'
function Invoke-RestMethod { throw 'unreachable' }
Assert ((Resolve-CrapEndpoint) -eq 'https://fallback.example') 'Offline LAN did not fall back'
Write-CrapText (Join-Path $dir 'endpoint') 'https://lan.example'
$blocked = $false
try { Resolve-CrapEndpoint } catch { $blocked = $true }
Assert $blocked 'Unreachable LAN without fallback was accepted'
Remove-Item Function:\Invoke-RestMethod
Remove-CrapIntegration
Assert (-not ([IO.File]::ReadAllText($profileFile)).Contains('# CRAP shell integration')) 'Uninstall left loader'
Assert ([IO.File]::ReadAllText($profileFile).Contains('# existing profile content')) 'Uninstall damaged profile'
Assert (-not (Test-Path -LiteralPath (Join-Path $dir 'key.xml'))) 'Uninstall retained key'
Assert (-not (Get-Command claude -CommandType Function -ErrorAction SilentlyContinue)) 'Uninstall retained wrapper'
function global:claude { 'custom original' }
$blocked = $false
try { . $sourceFile -Install -HomeDirectory $crapFixture -ProfilePath $profileFile -ClaudePath $fakeClaude } catch { $blocked = $true }
Assert $blocked 'Existing custom alias/function was overwritten'
Assert ((claude) -eq 'custom original') 'Custom function changed'
Write-Output 'PowerShell install, idempotency, launch isolation, history, credentials, conflicts and uninstall passed.'
