@echo off
echo Compiling capture.exe...
where csc >nul 2>&1
if %errorlevel%==0 (
    csc /optimize /unsafe /out:capture.exe capture.cs /r:System.Drawing.dll /r:System.Windows.Forms.dll
) else (
    echo csc not found in PATH.
    echo Trying .NET Framework path...
    set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
    if exist %CSC% (
        %CSC% /optimize /unsafe /out:capture.exe capture.cs /r:System.Drawing.dll /r:System.Windows.Forms.dll
    ) else (
        echo ERROR: C# compiler not found. Install .NET Framework or .NET SDK.
        exit /b 1
    )
)
if exist capture.exe (
    echo Done: capture.exe
) else (
    echo Build failed.
)
