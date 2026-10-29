@echo off
chcp 65001 >nul
title 切换对话模型 - DeepSeek
echo 请在 AI Design Hub 的模型设置中选择 DeepSeek V4.1 Flash。
echo 已接入的模型可直接在 AI Hub / AI Design 的对话模型菜单选择，无需重输密钥。
tasklist /FI "IMAGENAME eq AIDesignHub.exe" /NH | find /I "AIDesignHub.exe" >nul
if errorlevel 1 start "" "%LOCALAPPDATA%\Programs\AIDesignHub\AIDesignHub.exe"
echo.
echo 请沿用已经打开的工作台窗口。模型设置会立即生效。
pause
