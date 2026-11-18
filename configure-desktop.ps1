param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$data = Join-Path $env:LOCALAPPDATA 'CopilotProxy'
$configPath = Join-Path $env:USERPROFILE '.codex\config.toml'
$statePath = Join-Path $data 'desktop-integration.json'
$begin = '# BEGIN copilot-local-proxy desktop provider'
$end = '# END copilot-local-proxy desktop provider'
$blockPattern = '(?ms)^' + [regex]::Escape($begin) + '\r?\n.*?^' + [regex]::Escape($end) + '\r?\n?'
$text = if (Test-Path -LiteralPath $configPath) { [IO.File]::ReadAllText($configPath) } else { '' }
$original = $text
$newline = if ([regex]::Match($text, '\r?\n').Value -eq "`r`n") { "`r`n" } else { "`n" }
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json }
$owned = [ordered]@{ model_provider = '"copilot-local"'; web_search = '"disabled"' }

function Get-TopLevelEnd([string]$Content) {
    $section = [regex]::Match($Content, '(?m)^[ \t]*\[')
    if ($section.Success) { return $section.Index }
    return $Content.Length
}

if ($Remove) {
    if (-not $state) { return }
    $text = [regex]::Replace($text, $blockPattern, '')
    $offset = Get-TopLevelEnd $text
    $head = $text.Substring(0, $offset)
    $tail = $text.Substring($offset)
    foreach ($key in $owned.Keys) {
        $pattern = '(?m)^' + [regex]::Escape($key) + '[ \t]*=[ \t]*' + [regex]::Escape($owned[$key]) + '[ \t]*(?:\r?\n|$)'
        $previous = $state.previous.$key
        $replacement = if ($null -ne $previous) { [string]$previous + $newline } else { '' }
        $head = [regex]::new($pattern).Replace($head, [Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement }, 1)
    }
    $text = $head + $tail
}
else {
    $profilePath = Join-Path $env:USERPROFILE '.codex\copilot-local.config.toml'
    $profile = [IO.File]::ReadAllText($profilePath)
    $start = $profile.IndexOf('[model_providers.copilot-local]')
    if ($start -lt 0) { throw 'Install the proxy before configuring the desktop app.' }
    $text = [regex]::Replace($text, $blockPattern, '')
    if ($text -match '(?m)^\[model_providers\.copilot-local(?:\]|\.|\s)') {
        throw 'An unmanaged copilot-local desktop provider already exists; refusing to overwrite it.'
    }
    $offset = Get-TopLevelEnd $text
    $head = $text.Substring(0, $offset)
    $tail = $text.Substring($offset)
    if (-not $state) {
        $previous = [ordered]@{}
        foreach ($key in $owned.Keys) {
            $match = [regex]::Match($head, '(?m)^' + [regex]::Escape($key) + '[ \t]*=[^\r\n]*')
            $previous[$key] = if ($match.Success) { $match.Value } else { $null }
        }
        $state = [pscustomobject]@{ previous = $previous }
    }
    foreach ($key in $owned.Keys) {
        $pattern = '(?m)^' + [regex]::Escape($key) + '[ \t]*=[^\r\n]*'
        $line = $key + ' = ' + $owned[$key]
        if ([regex]::IsMatch($head, $pattern)) {
            $head = [regex]::new($pattern).Replace($head, [Text.RegularExpressions.MatchEvaluator]{ param($m) $line }, 1)
        } else { $head = $line + $newline + $head }
    }
    $text = $head + $tail
    $provider = [regex]::Replace($profile.Substring($start).TrimEnd(), '\r?\n', $newline)
    $text = $text.TrimEnd() + $newline + $newline + $begin + $newline +
        $provider + $newline + $end + $newline
}

if ($text -ne $original) {
    if ((Test-Path -LiteralPath $configPath) -and [IO.File]::ReadAllText($configPath) -ne $original) {
        throw 'Codex configuration changed during integration; retry without overwriting the concurrent edit.'
    }
    if (Test-Path -LiteralPath $configPath) {
        Copy-Item -LiteralPath $configPath -Destination (Join-Path $data ('codex-config-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '.toml'))
    }
    if (-not $Remove) {
        [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText($configPath, $text, [Text.UTF8Encoding]::new($false))
}
if ($Remove) {
    Remove-Item -LiteralPath $statePath
    Write-Output 'Restored owned desktop settings that were still selected; preserved unrelated config and backups.'
} else {
    Write-Output 'Codex desktop default now uses Local GitHub Copilot. Open a new local chat; restart the app if it retains the previous provider.'
}
