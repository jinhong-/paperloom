# Build the Paperloom firmware.
#
# ESP-IDF needs a specific toolchain and Python environment. On Windows
# that means loading its export script before running idf.py, and the
# export script in turn needs IDF_TOOLS_PATH to point at the directory
# holding the compiler, cmake, ninja and the Python environment.
#
# This wrapper resolves all of that so the build is a single command.
#
# Usage:  .\build.ps1 [idf.py arguments]
#         .\build.ps1 build
#         .\build.ps1 flash monitor

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------
# Locate ESP-IDF
# ---------------------------------------------------------------------

$idfPath = $env:IDF_PATH
if (-not $idfPath) {
    $idfPath = "C:\esp\v6.0.1\esp-idf"
}
if (-not (Test-Path $idfPath)) {
    Write-Error "ESP-IDF not found at $idfPath. Set IDF_PATH and try again."
}
$env:IDF_PATH = $idfPath

# ---------------------------------------------------------------------
# Locate the tools
# ---------------------------------------------------------------------

# The tools directory holds the compiler, cmake, ninja and the Python
# environment. Look for whichever one already has the compiler installed.
$toolsRoot = $env:IDF_TOOLS_PATH
if (-not $toolsRoot) {
    foreach ($candidate in @("C:\Espressif", "$env:USERPROFILE\.espressif")) {
        if (Test-Path (Join-Path $candidate "tools\xtensa-esp-elf")) {
            $toolsRoot = $candidate
            break
        }
    }
}
if (-not $toolsRoot) {
    Write-Error "Could not find the ESP-IDF tools. Set IDF_TOOLS_PATH and try again."
}
$env:IDF_TOOLS_PATH = $toolsRoot

# ---------------------------------------------------------------------
# Locate the Python environment
# ---------------------------------------------------------------------

# The environment must sit under IDF_TOOLS_PATH for the export script to
# find it. If it is installed elsewhere, point at it directly.
$idfPython = Join-Path $toolsRoot "python_env\idf6.0_py3.11_env"
if (-not (Test-Path $idfPython)) {
    $idfPython = $env:IDF_PYTHON_ENV_PATH
}
if (-not $idfPython -or -not (Test-Path $idfPython)) {
    Write-Error "Could not find the ESP-IDF Python environment."
}
$env:IDF_PYTHON_ENV_PATH = $idfPython

$pythonExe = Join-Path $idfPython "Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
    Write-Error "The ESP-IDF Python interpreter was not found at $pythonExe."
}

# The component manager reads ESP_IDF_VERSION to decide which extensions
# are available.
if (-not $env:ESP_IDF_VERSION) {
    $versionFile = Join-Path $idfPath "version.txt"
    if (Test-Path $versionFile) {
        $env:ESP_IDF_VERSION = (Get-Content $versionFile -Raw).Trim()
    } else {
        $env:ESP_IDF_VERSION = "6.0.1"
    }
}

# ---------------------------------------------------------------------
# Load the environment
# ---------------------------------------------------------------------

# The export script writes its progress to stderr, which PowerShell would
# otherwise treat as a terminating error. Turn the error preference off
# around the dot-sourcing so the messages stay visible.
$ErrorActionPreference = "Continue"
. "$idfPath\export.ps1"
$ErrorActionPreference = "Stop"

# The export script's PATH changes do not always survive dot-sourcing into
# this scope on Windows, so make sure the build tools are reachable. The
# tools live in versioned subdirectories, so they are found by searching
# rather than by assuming a fixed layout.
foreach ($tool in @("cmake", "ninja", "ccache")) {
    Get-ChildItem (Join-Path $toolsRoot "tools\$tool") -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
            foreach ($leaf in @("bin", "")) {
                $bin = if ($leaf) { Join-Path $_.FullName $leaf } else { $_.FullName }
                if (Test-Path $bin) {
                    $env:PATH = "$bin;$env:PATH"
                }
            }
        }
}
foreach ($toolchain in @("xtensa-esp-elf", "riscv32-esp-elf")) {
    Get-ChildItem (Join-Path $toolsRoot "tools\$toolchain") -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
            $bin = Join-Path $_.FullName "$toolchain\bin"
            if (Test-Path $bin) {
                $env:PATH = "$bin;$env:PATH"
            }
        }
}

# The ROM ELF files let the debugger resolve addresses inside the ROM. The
# build needs the directory even when nobody is going to debug.
if (-not $env:ESP_ROM_ELF_DIR) {
    $romElf = Get-ChildItem (Join-Path $toolsRoot "tools\esp-rom-elfs") -Directory -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($romElf) {
        $env:ESP_ROM_ELF_DIR = $romElf.FullName
    }
}

Set-Location $PSScriptRoot

# Invoke idf.py through the IDF Python rather than relying on it being on
# PATH.
#
# The output is written to a log file as well as to the console. The
# build produces a great deal of output and PowerShell's error stream
# interleaving makes it easy to lose the lines that matter, so the file is
# the authoritative record.
$logPath = Join-Path $PSScriptRoot "build-output.log"

& $pythonExe "$idfPath\tools\idf.py" @args 2>&1 | Tee-Object -FilePath $logPath
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host ""
    Write-Host "The build failed. The last lines of the log were:" -ForegroundColor Yellow
    Get-Content $logPath -Tail 40 | ForEach-Object { Write-Host "  $_" }
}

exit $code
