@echo off
title CBT SMK Negeri 1 Lempuing Local Server
echo =======================================================
echo CBT SMK NEGERI 1 LEMPUING - LOCAL SERVER
echo =======================================================
echo.
echo Meluncurkan server lokal menggunakan Python...
echo Server berjalan di http://localhost:8080
echo.
echo Membuka browser default ke halaman login CBT...
start http://localhost:8080/login.html
echo.
echo Tekan [Ctrl + C] untuk menghentikan server.
echo.
python -m http.server 8080
pause
