@echo off
setlocal
set "BOOTSTRAP=%TEMP%\Loven7-Mail-Bootstrap-%RANDOM%.ps1"
set "CHECKSUMS=%TEMP%\Loven7-Mail-SHA256SUMS-%RANDOM%.txt"
set "BOOTSTRAP_URL=https://github.com/Lur1N77777/loven7-mail/releases/latest/download/loven7-mail-bootstrap.ps1"
set "CHECKSUMS_URL=https://github.com/Lur1N77777/loven7-mail/releases/latest/download/SHA256SUMS.txt"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%BOOTSTRAP_URL%' -OutFile '%BOOTSTRAP%'; Invoke-WebRequest -UseBasicParsing -Uri '%CHECKSUMS_URL%' -OutFile '%CHECKSUMS%'; `$line = Get-Content -LiteralPath '%CHECKSUMS%' | Where-Object { `$_ -match 'loven7-mail-bootstrap\.ps1' } | Select-Object -First 1; if (-not `$line) { throw 'Bootstrap checksum is missing.' }; `$expected = (`$line -split '\s+')[0].ToLowerInvariant(); `$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath '%BOOTSTRAP%').Hash.ToLowerInvariant(); if (`$expected -notmatch '^[0-9a-f]{64}$' -or `$expected -ne `$actual) { throw 'Bootstrap SHA-256 verification failed.' }; & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File '%BOOTSTRAP%' %*; exit `$LASTEXITCODE"
set "EXIT_CODE=%ERRORLEVEL%"
del /q "%BOOTSTRAP%" >nul 2>&1
del /q "%CHECKSUMS%" >nul 2>&1

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Loven7 Mail installer exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
