@echo off
title Upload CBT ke GitHub
cls
echo ===============================================================
echo       UNGGAH PEMBARUAN CBT KE GITHUB (acandraa/cbt-smkn1-lpg)
echo ===============================================================
echo.
echo Memulai proses upload ke GitHub...
echo.

git add -A
git diff --cached --quiet || git commit -m "Update CBT SMKN 1 Lempuing"
git push origin main --force-with-lease

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ===============================================================
    echo [SUKSES] Semua file pembaruan CBT berhasil diunggah ke GitHub!
    echo ===============================================================
    echo.
    echo Website CBT Anda online di:
    echo https://acandraa.github.io/cbt-smkn1-lpg/
    echo ===============================================================
) else (
    echo.
    echo ===============================================================
    echo [GAGAL] Unggah belum berhasil.
    echo ===============================================================
)

echo.
pause
