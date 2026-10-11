@echo off
rem ---------------------------------------------------------------
rem  Set up the Rust toolchain for Tauri builds.
rem
rem  Rust is installed at <Rust 安装目录>, which is NOT on PATH by
rem  default. The Tauri CLI shells out to `cargo`, so without this
rem  the build fails with "cargo not found".
rem
rem  Usage:   call scripts\rust-env.bat  &&  npx tauri build
rem
rem  Keep this file pure ASCII: cmd.exe parses .bat with the OEM
rem  codepage, so non-ASCII bytes turn into mojibake or break it.
rem ---------------------------------------------------------------

set CARGO_HOME=<Rust 安装目录>\cargo
set RUSTUP_HOME=<Rust 安装目录>\rustup
set PATH=<Rust 安装目录>\cargo\bin;%PATH%

echo [rust-env] CARGO_HOME=%CARGO_HOME%
echo [rust-env] RUSTUP_HOME=%RUSTUP_HOME%

rem Fail loudly if the toolchain is missing, instead of letting
rem the build fail later with a confusing linker error.
where cargo >nul 2>nul
if errorlevel 1 (
  echo [rust-env] ERROR: cargo not found. Is Rust installed at <Rust 安装目录> ?
  exit /b 1
)

for /f "tokens=*" %%i in ('rustc -vV ^| findstr "^host:"') do set RUST_HOST=%%i
echo [rust-env] %RUST_HOST%

rem Tauri on Windows REQUIRES the msvc toolchain. The gnu one cannot
rem link against WebView2, so catch a gnu default here.
echo %RUST_HOST% | findstr /i "msvc" >nul
if errorlevel 1 (
  echo [rust-env] ERROR: active toolchain is not msvc. Tauri needs:
  echo              rustup default stable-x86_64-pc-windows-msvc
  exit /b 1
)
