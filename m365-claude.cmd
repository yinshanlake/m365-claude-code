@echo off
pwsh -NoProfile -File "%~dp0m365-claude.ps1" %*
exit /b %ERRORLEVEL%
