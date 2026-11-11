@echo off
title Upload CBT ke GitHub
cls
echo ===============================================================
echo       UNGGAH APLIKASI CBT KE GITHUB (acandraa/cbt-smkn1-lpg)
echo ===============================================================
echo.
echo Pastikan Anda sudah membuat repository di GitHub:
echo https://github.com/new?name=cbt-smkn1-lpg
echo.
echo Memulai proses push ke GitHub...
echo.

git push -u origin main

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ===============================================================
    echo [SUKSES] Semua file CBT berhasil diunggah ke GitHub!
    echo ===============================================================
    echo.
    echo Langkah Terakhir: Aktifkan GitHub Pages di link berikut:
    echo https://github.com/acandraa/cbt-smkn1-lpg/settings/pages
    echo (Pilih Branch: main, Folder: / (root), lalu klik Save)
    echo.
    echo Website CBT Anda akan online di:
    echo https://acandraa.github.io/cbt-smkn1-lpg/
    echo ===============================================================
) else (
    echo.
    echo ===============================================================
    echo [GAGAL] Unggah belum berhasil.
    echo Pastikan repository 'cbt-smkn1-lpg' sudah dibuat di github.com!
    echo ===============================================================
)

echo.
pause

