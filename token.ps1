$ErrorActionPreference = 'Stop'
$path = Join-Path $env:LOCALAPPDATA 'CopilotProxy\local-key.dpapi'
$secure = ConvertTo-SecureString (Get-Content -LiteralPath $path -Raw).Trim()
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secure.Dispose()
}
