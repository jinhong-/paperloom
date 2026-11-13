#!/usr/bin/env python3
"""
Watch the frame's serial log.

The board's USB-UART bridge is wired to the chip's EN and GPIO0, so a
serial port that holds DTR and RTS asserted keeps the chip in reset. The
frame then never sleeps: it is reset over and over, and it looks as
though the wake-up timer is firing early.

Flashing is not affected, because the flashing tool pulses those lines
itself to enter the bootloader and lets them go afterwards. It is only
the monitor that has to let go.

Usage:
    python monitor.py               # watch COM4
    python monitor.py COM4 115200   # watch a particular port
"""

from __future__ import annotations

import sys
import time

try:
    import serial
except ImportError:
    print("This needs pyserial, which comes with the ESP-IDF.", file=sys.stderr)
    sys.exit(1)

DEFAULT_PORT = "COM4"
DEFAULT_BAUD = 115200


def main() -> int:
    port = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PORT
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_BAUD

    try:
        s = serial.Serial(port, baud, timeout=0.2)
    except serial.SerialException as error:
        print(f"Could not open {port}: {error}", file=sys.stderr)
        return 1

    # Let go of the modem control lines, so that the chip is free to
    # sleep.
    s.dtr = False
    s.rts = False

    print(f"Watching {port} at {baud} baud. The reset lines are released.")
    print("Press Ctrl-C to stop.")
    print()

    try:
        while True:
            data = s.read(4096)
            if data:
                sys.stdout.write(data.decode("utf-8", errors="replace"))
                sys.stdout.flush()
    except KeyboardInterrupt:
        print()
    finally:
        s.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
