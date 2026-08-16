@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "INSTALLER_LANG="
if /I "%~1"=="--lang" (
  if /I "%~2"=="zh" set "INSTALLER_LANG=zh-CN"
  if /I "%~2"=="zh-CN" set "INSTALLER_LANG=zh-CN"
  if /I "%~2"=="en" set "INSTALLER_LANG=en"
)
if /I "%~1"=="--lang=en" set "INSTALLER_LANG=en"
if /I "%~1"=="--lang=zh" set "INSTALLER_LANG=zh-CN"
if /I "%~1"=="--lang=zh-CN" set "INSTALLER_LANG=zh-CN"
if defined INSTALLER_LANG goto language_selected

echo.
echo ============================================================
echo   Loven7 Mail Installer
echo ============================================================
echo   1. 中文
echo   2. English
echo.

:select_language
set "LANGUAGE_CHOICE="
set /p "LANGUAGE_CHOICE=请选择语言 / Select language [1]: "
if not defined LANGUAGE_CHOICE set "LANGUAGE_CHOICE=1"
if /I "%LANGUAGE_CHOICE%"=="1" (set "INSTALLER_LANG=zh-CN" & goto language_selected)
if /I "%LANGUAGE_CHOICE%"=="zh" (set "INSTALLER_LANG=zh-CN" & goto language_selected)
if /I "%LANGUAGE_CHOICE%"=="zh-CN" (set "INSTALLER_LANG=zh-CN" & goto language_selected)
if /I "%LANGUAGE_CHOICE%"=="2" (set "INSTALLER_LANG=en" & goto language_selected)
if /I "%LANGUAGE_CHOICE%"=="en" (set "INSTALLER_LANG=en" & goto language_selected)
echo 请输入 1 或 2。 / Enter 1 or 2.
goto select_language

:language_selected
set "LOVEN7_MAIL_LANG=%INSTALLER_LANG%"
if /I "%INSTALLER_LANG%"=="en" (
  echo.
  echo Downloading and verifying the latest installer...
) else (
  echo.
  echo 正在下载并校验最新版安装器...
)

set "BOOTSTRAP=%TEMP%\Loven7-Mail-Bootstrap-%RANDOM%.ps1"
set "CHECKSUMS=%TEMP%\Loven7-Mail-SHA256SUMS-%RANDOM%.txt"
set "BOOTSTRAP_URL=https://github.com/Lur1N77777/loven7-mail/releases/latest/download/loven7-mail-bootstrap.ps1"
set "CHECKSUMS_URL=https://github.com/Lur1N77777/loven7-mail/releases/latest/download/SHA256SUMS.txt"
set "LOVEN7_BOOTSTRAP_PATH=%BOOTSTRAP%"
set "LOVEN7_CHECKSUMS_PATH=%CHECKSUMS%"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop'; try { $env:PSModulePath = Join-Path $PSHOME 'Modules'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%BOOTSTRAP_URL%' -OutFile $env:LOVEN7_BOOTSTRAP_PATH; Invoke-WebRequest -UseBasicParsing -Uri '%CHECKSUMS_URL%' -OutFile $env:LOVEN7_CHECKSUMS_PATH; $line = Get-Content -LiteralPath $env:LOVEN7_CHECKSUMS_PATH | Where-Object { $_ -match 'loven7-mail-bootstrap\.ps1' } | Select-Object -First 1; if (-not $line) { if ($env:LOVEN7_MAIL_LANG -eq 'en') { throw 'Bootstrap checksum is missing.' } else { throw '校验文件中缺少 bootstrap 哈希。' } }; $expected = ($line -split '\s+')[0].ToLowerInvariant(); $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $env:LOVEN7_BOOTSTRAP_PATH).Hash.ToLowerInvariant(); if ($expected -notmatch '^[0-9a-f]{64}$' -or $expected -ne $actual) { if ($env:LOVEN7_MAIL_LANG -eq 'en') { throw 'Bootstrap SHA-256 verification failed.' } else { throw 'Bootstrap SHA-256 校验失败。' } }; exit 0 } catch { if ($env:LOVEN7_MAIL_LANG -eq 'en') { Write-Host 'Download or verification failed.' -ForegroundColor Red } else { Write-Host '下载或校验失败。' -ForegroundColor Red }; Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto cleanup

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -InstallerLanguage "%INSTALLER_LANG%" %*
set "EXIT_CODE=%ERRORLEVEL%"

:cleanup
del /q "%BOOTSTRAP%" >nul 2>&1
del /q "%CHECKSUMS%" >nul 2>&1

if not "%EXIT_CODE%"=="0" (
  echo.
  if /I "%INSTALLER_LANG%"=="en" (
    echo Loven7 Mail installer exited with code %EXIT_CODE%.
    set /p "WAIT_FOR_ENTER=Press Enter to close..."
  ) else (
    echo Loven7 Mail 安装器已退出，错误代码：%EXIT_CODE%。
    set /p "WAIT_FOR_ENTER=按 Enter 键关闭..."
  )
)
exit /b %EXIT_CODE%
