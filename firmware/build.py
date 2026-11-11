#!/usr/bin/env python3
"""
Build, flash and monitor the Paperloom firmware.

The normal way to build an ESP-IDF project is to activate the environment
and run `idf.py`. This script does that when the environment is already
active, and otherwise falls back to locating the toolchain itself, which
saves a lot of time on a machine where the environment is not permanently
configured.

Usage:
    python build.py build              # build the firmware
    python build.py flash              # flash it
    python build.py flash monitor      # flash it and watch the log
    python build.py monitor            # watch the log
    python build.py fullclean build    # start from scratch
    python build.py build -- -DIDF_TARGET=esp32s3

Any arguments after `--` are passed straight through to `idf.py`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

ROOT = Path(__file__).resolve().parent

# Commands that idf.py understands and that we forward.
IDF_COMMANDS = ("build", "flash", "monitor", "fullclean", "size", "menuconfig")


def log(message: str) -> None:
    print(message, flush=True)

def fail(message: str, code: int = 1) -> NoReturn:
    print(f"\nError: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


# ---------------------------------------------------------------------------
# Environment discovery
# ---------------------------------------------------------------------------


def find_idf_on_path() -> list[str] | None:
    """
    The idf.py to run, if the environment is already active.

    The export script puts idf.py on PATH. On POSIX that is the script
    itself; on Windows it may be a .bat wrapper, which cannot be executed
    directly with the current interpreter, so the underlying Python script
    is preferred when it can be found.
    """
    on_path = shutil.which("idf.py")
    if on_path is not None:
        return [on_path]

    # Some Windows installations expose a .bat wrapper instead.
    wrapper = shutil.which("idf.py.bat") or shutil.which("idf.bat")
    if wrapper is not None:
        idf_path = os.environ.get("IDF_PATH")
        if idf_path:
            script = Path(idf_path) / "tools" / "idf.py"
            if script.is_file():
                return [sys.executable, str(script)]

    # The export script may have put the tools directory on PATH without a
    # wrapper.
    idf_path = os.environ.get("IDF_PATH")
    if idf_path:
        script = Path(idf_path) / "tools" / "idf.py"
        if script.is_file() and str(script.parent) in os.environ.get("PATH", "").split(os.pathsep):
            return [sys.executable, str(script)]

    return None


def candidate_idf_paths() -> list[Path]:
    """Places ESP-IDF is commonly installed."""
    candidates: list[Path] = []

    from_env = os.environ.get("IDF_PATH")
    if from_env:
        candidates.append(Path(from_env))

    # The usual Windows and POSIX install locations.
    candidates.append(Path("C:/Espressif/frameworks/esp-idf-v5.3"))
    candidates.append(Path("C:/esp/v6.0.1/esp-idf"))
    candidates.append(Path.home() / "esp" / "esp-idf")
    candidates.append(Path("/opt/esp/idf"))

    # Anything under the tools root, if there is one.
    tools = os.environ.get("IDF_TOOLS_PATH")
    if tools:
        root = Path(tools)
        for pattern in ("esp-idf*", "frameworks/esp-idf*"):
            candidates.extend(sorted(root.glob(pattern)))

    return [c for c in candidates if (c / "tools" / "idf.py").is_file()]


def idf_version(idf_path: Path) -> str | None:
    """
    The ESP-IDF version, as "major.minor".

    The export script needs this to find the Python environment, and the
    component manager needs it too. It lives in different places depending
    on the version, so a couple of layouts are tried.
    """
    # ESP-IDF v5 and later: tools/cmake/version.cmake
    version_cmake = idf_path / "tools" / "cmake" / "version.cmake"
    if version_cmake.is_file():
        text = version_cmake.read_text(encoding="utf-8")
        major = re.search(r"IDF_VERSION_MAJOR\s+(\d+)", text)
        minor = re.search(r"IDF_VERSION_MINOR\s+(\d+)", text)
        if major and minor:
            return f"{major.group(1)}.{minor.group(1)}"

    # Older layouts: version.txt
    version_txt = idf_path / "version.txt"
    if version_txt.is_file():
        return ".".join(version_txt.read_text(encoding="utf-8").strip().split(".")[:2])

    return None


def find_python_env(idf_path: Path) -> Path | None:
    """
    Locate the ESP-IDF Python environment.

    The export script insists the environment lives under IDF_TOOLS_PATH,
    and that is the authoritative location. The other places are only
    consulted when IDF_TOOLS_PATH is not set, or when it does not hold an
    environment.

    Picking a different environment than the export script would is not
    harmless: ESP-IDF records the interpreter in the build directory and
    refuses to continue if it changes, so the two must agree.
    """
    version = idf_version(idf_path)
    if version is None:
        return None

    # The environments are named after the version with the dot removed,
    # e.g. "idf5.3_py3.11_env" and "idf6.0_py3.11_env".
    tags = [version.replace(".", "")]
    if version.startswith("6."):
        # v6 renamed the environment to drop the patch level.
        tags.append("6.0")

    def search(root: Path) -> Path | None:
        if not root.is_dir():
            return None
        for tag in tags:
            for candidate in sorted(root.glob(f"idf{tag}_*")):
                if (candidate / "Scripts" / "python.exe").is_file() or (
                    candidate / "bin" / "python"
                ).is_file():
                    return candidate
        return None

    # IDF_TOOLS_PATH is where the export script looks first.
    tools_root = find_tools_root()
    if tools_root is not None:
        found = search(tools_root / "python_env")
        if found is not None:
            return found

    # Otherwise, use the first environment we can find. The default
    # location on both Windows and POSIX is under the user's home.
    for root in (Path.home() / ".espressif" / "python_env", Path("C:/Espressif/python_env")):
        found = search(root)
        if found is not None:
            return found

    return None


def tool_binary(root: Path, tool: str, subdir: str = "bin") -> Path | None:
    """Find a tool binary, looking through the versioned subdirectories."""
    base = root / "tools" / tool
    if not base.is_dir():
        return None

    for version_dir in sorted(base.iterdir()):
        if not version_dir.is_dir():
            continue
        for relative in (subdir, "", "toolchain/bin"):
            candidate = version_dir / relative
            for name in (f"{tool}.exe", tool):
                binary = candidate / name
                if binary.is_file():
                    return binary

    return None


def find_tools_root() -> Path | None:
    """
    Locate the ESP-IDF tools directory.

    This holds the compiler, cmake, ninja and the Python environment. The
    export script calls it IDF_TOOLS_PATH, and it normally sits beside the
    ESP-IDF installation.
    """
    from_env = os.environ.get("IDF_TOOLS_PATH")
    if from_env:
        root = Path(from_env)
        if (root / "tools").is_dir():
            return root

    # The usual install layouts.
    candidates = [
        Path("C:/Espressif"),
        Path.home() / ".espressif",
        Path("/opt/esp"),
    ]
    for candidate in candidates:
        if (candidate / "tools").is_dir():
            return candidate

    return None


def build_environment(idf_path: Path) -> dict[str, str] | None:
    """
    Assemble an environment that can run idf.py.

    Returns None if the environment already looks usable, in which case the
    caller's shell is assumed to be set up correctly.
    """
    env = dict(os.environ)
    env["IDF_PATH"] = str(idf_path)

    # The component manager reads this to decide which extensions exist.
    version = idf_version(idf_path)
    if version:
        env.setdefault("ESP_IDF_VERSION", version)

    tools_root = find_tools_root()
    if tools_root is None:
        return None

    env["IDF_TOOLS_PATH"] = str(tools_root)
    tools = tools_root

    # The Python environment.
    python_env = find_python_env(idf_path)
    if python_env is not None:
        env["IDF_PYTHON_ENV_PATH"] = str(python_env)
        scripts = python_env / "Scripts"
        if scripts.is_dir():
            env["PATH"] = f"{scripts}{os.pathsep}{env['PATH']}"

    # The build tools. They live in versioned subdirectories, so they are
    # found by searching rather than by assuming a fixed layout.
    for tool in ("cmake", "ninja", "ccache"):
        binary = tool_binary(tools, tool)
        if binary is not None:
            env["PATH"] = f"{binary.parent}{os.pathsep}{env['PATH']}"

    for toolchain in ("xtensa-esp-elf", "riscv32-esp-elf"):
        base = tools / "tools" / toolchain
        if not base.is_dir():
            continue
        for version_dir in sorted(base.iterdir()):
            binary_dir = version_dir / toolchain / "bin"
            if binary_dir.is_dir():
                env["PATH"] = f"{binary_dir}{os.pathsep}{env['PATH']}"

    # The ROM ELF files let the debugger resolve addresses inside the ROM.
    # The build needs the directory even when nobody is going to debug.
    if not env.get("ESP_ROM_ELF_DIR"):
        rom_elfs = tools / "tools" / "esp-rom-elfs"
        if rom_elfs.is_dir():
            versions = sorted(p for p in rom_elfs.iterdir() if p.is_dir())
            if versions:
                env["ESP_ROM_ELF_DIR"] = str(versions[-1])

    return env


# Where the Python environment that was used for the last build is
# recorded. ESP-IDF refuses to continue when the interpreter changes, so
# the script remembers its choice and reuses it.
ENV_MARKER = ROOT / ".paperloom-env.json"


def remember_environment(env: dict[str, str]) -> None:
    """Record the environment used for this build."""
    try:
        ENV_MARKER.write_text(
            json.dumps(
                {
                    "IDF_PATH": env.get("IDF_PATH", ""),
                    "IDF_TOOLS_PATH": env.get("IDF_TOOLS_PATH", ""),
                    "IDF_PYTHON_ENV_PATH": env.get("IDF_PYTHON_ENV_PATH", ""),
                    "ESP_IDF_VERSION": env.get("ESP_IDF_VERSION", ""),
                    "ESP_ROM_ELF_DIR": env.get("ESP_ROM_ELF_DIR", ""),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except OSError:
        pass


def recall_environment() -> dict[str, str] | None:
    """
    The environment used for the last build, if it is still usable.

    Using the same environment as the previous build avoids ESP-IDF's
    "the Python interpreter changed" error, which happens when the
    environment is found at a different path than before.
    """
    if not ENV_MARKER.is_file():
        return None

    try:
        saved = json.loads(ENV_MARKER.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    idf_path = saved.get("IDF_PATH")
    python_env = saved.get("IDF_PYTHON_ENV_PATH")
    if not idf_path or not python_env:
        return None

    idf = Path(idf_path)
    python = Path(python_env)
    if not (idf / "tools" / "idf.py").is_file():
        return None
    if not (
        (python / "Scripts" / "python.exe").is_file()
        or (python / "bin" / "python").is_file()
    ):
        return None

    env = dict(os.environ)
    env["IDF_PATH"] = str(idf)
    env["IDF_PYTHON_ENV_PATH"] = str(python)
    if saved.get("IDF_TOOLS_PATH"):
        env["IDF_TOOLS_PATH"] = saved["IDF_TOOLS_PATH"]

    # The component manager reads ESP_IDF_VERSION to decide which
    # extensions are available, and the build needs the ROM ELF directory
    # even when nobody is going to debug.
    version = saved.get("ESP_IDF_VERSION") or idf_version(idf)
    if version:
        env["ESP_IDF_VERSION"] = version
    if saved.get("ESP_ROM_ELF_DIR"):
        env["ESP_ROM_ELF_DIR"] = saved["ESP_ROM_ELF_DIR"]

    # The build tools have to be on PATH for the compiler to be found.
    tools_root = find_tools_root()
    if tools_root is not None:
        for tool in ("cmake", "ninja", "ccache"):
            binary = tool_binary(tools_root, tool)
            if binary is not None:
                env["PATH"] = f"{binary.parent}{os.pathsep}{env['PATH']}"
        for toolchain in ("xtensa-esp-elf", "riscv32-esp-elf"):
            base = tools_root / "tools" / toolchain
            if not base.is_dir():
                continue
            for version_dir in sorted(base.iterdir()):
                binary_dir = version_dir / toolchain / "bin"
                if binary_dir.is_dir():
                    env["PATH"] = f"{binary_dir}{os.pathsep}{env['PATH']}"

    scripts = python / "Scripts"
    if not scripts.is_dir():
        scripts = python / "bin"
    if scripts.is_dir():
        env["PATH"] = f"{scripts}{os.pathsep}{env['PATH']}"

    return env


def resolve_idf() -> tuple[list[str], dict[str, str]]:
    """
    Work out how to run idf.py.

    Returns the command and the environment to run it with.
    """
    # The idiomatic path: the environment is already active.
    on_path = find_idf_on_path()
    if on_path is not None:
        log("Using the ESP-IDF environment from PATH.")
        return on_path, dict(os.environ)

    # Reuse the environment the last build used, so that the interpreter
    # does not change under ESP-IDF's feet.
    remembered = recall_environment()
    if remembered is not None:
        python = None
        for name in ("Scripts/python.exe", "bin/python"):
            candidate = Path(remembered["IDF_PYTHON_ENV_PATH"]) / name
            if candidate.is_file():
                python = str(candidate)
                break
        if python is not None:
            log("Reusing the ESP-IDF Python environment from the last build.")
            return (
                [python, str(Path(remembered["IDF_PATH"]) / "tools" / "idf.py")],
                remembered,
            )

    # Otherwise, find the installation and set the environment up.
    for candidate in candidate_idf_paths():
        env = build_environment(candidate)
        if env is None:
            continue

        python = None
        python_env = env.get("IDF_PYTHON_ENV_PATH")
        if python_env:
            for name in ("Scripts/python.exe", "bin/python"):
                candidate_python = Path(python_env) / name
                if candidate_python.is_file():
                    python = str(candidate_python)
                    break

        if python is None:
            python = shutil.which("python") or shutil.which("python3")
        if python is None:
            continue

        log(f"Using ESP-IDF at {candidate}.")
        return [python, str(candidate / "tools" / "idf.py")], env

    fail(
        "Could not find ESP-IDF.\n"
        "  Either activate the environment (source $IDF_PATH/export.sh on POSIX,\n"
        "  or . $IDF_PATH\\export.ps1 in PowerShell) and run idf.py directly,\n"
        "  or set IDF_PATH to point at your installation."
    )


# ---------------------------------------------------------------------------
# The build
# ---------------------------------------------------------------------------


def run_idf(command: list[str], extra: list[str], env: dict[str, str]) -> int:
    """Run idf.py with the given command."""
    full = command + extra

    log(f"Running: idf.py {' '.join(extra)}")
    log("")

    try:
        result = subprocess.run(full, cwd=ROOT, env=env)
    except FileNotFoundError:
        fail("Could not run idf.py.")
        return 1
    except KeyboardInterrupt:
        log("\nInterrupted.")
        return 130

    if result.returncode != 0:
        # ESP-IDF records the interpreter it was configured with and
        # refuses to continue if it changes. That happens when the Python
        # environment is found at a different path than the one used for
        # the previous build, which is confusing without an explanation.
        log("")
        log(
            "If the error above mentions the Python interpreter being "
            "'currently active' while the project was configured with a "
            "different one, the build directory was made with a different "
            "ESP-IDF Python environment."
        )
        log(
            "Run 'python build.py --clean build' to rebuild with the "
            "environment that is in use now."
        )

    return result.returncode


def main() -> int:
    # The arguments after "--" go straight to idf.py. They are split off
    # before argparse sees them, because argparse cannot tell a passthrough
    # argument from a command name when both are positional.
    argv = sys.argv[1:]
    passthrough: list[str] = []
    if "--" in argv:
        index = argv.index("--")
        argv, passthrough = argv[:index], argv[index + 1 :]

    parser = argparse.ArgumentParser(
        description="Build, flash and monitor the Paperloom firmware.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "command",
        nargs="*",
        help="One or more of: " + ", ".join(IDF_COMMANDS),
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove the build directory and the generated sdkconfig first.",
    )

    args = parser.parse_args(argv)

    commands = args.command
    if not commands:
        commands = ["build"]

    unknown = [c for c in commands if c not in IDF_COMMANDS]
    if unknown:
        fail(f"Unknown command(s): {', '.join(unknown)}")

    if args.clean:
        log("Cleaning the build directory...")
        shutil.rmtree(ROOT / "build", ignore_errors=True)
        sdkconfig = ROOT / "sdkconfig"
        if sdkconfig.is_file():
            sdkconfig.unlink()

    command, env = resolve_idf()
    remember_environment(env)

    return run_idf(command, commands + passthrough, env)


if __name__ == "__main__":
    sys.exit(main())
