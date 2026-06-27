@echo off
chcp 65001 >nul
title CNMI Smart Card Bridge
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CNMI-SmartCard-Bridge.ps1"
pause
