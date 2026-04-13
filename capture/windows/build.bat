@echo off
echo Building Windows capture (V3: DXGI + libdatachannel)...
echo.
echo Prerequisites:
echo   - Visual Studio 2022 (or Build Tools) with C++ workload
echo   - libdatachannel installed (vcpkg install libdatachannel)
echo.

where cl >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: cl.exe not found. Run from "Developer Command Prompt for VS 2022"
    exit /b 1
)

cl /O2 /EHsc /std:c++17 ^
    /I"%VCPKG_ROOT%\installed\x64-windows\include" ^
    capture.cpp ^
    /link ^
    /LIBPATH:"%VCPKG_ROOT%\installed\x64-windows\lib" ^
    d3d11.lib dxgi.lib mfplat.lib mfuuid.lib mf.lib mfreadwrite.lib ^
    datachannel.lib ^
    /OUT:capture.exe

if exist capture.exe (
    echo Done: capture.exe
) else (
    echo Build failed.
    exit /b 1
)
