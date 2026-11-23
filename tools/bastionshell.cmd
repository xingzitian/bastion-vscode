@echo off
rem BastionShell CLI 启动器：tools\bastionshell.cmd <档案>
rem 作用：起 node out\cli\main.js serve <档案>，等日志里出现网页终端地址，用默认浏览器打开。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bastionshell.cmd.ps1" %*
