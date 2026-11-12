#!/usr/bin/env python3
"""Generate the notification chime of the turn-sound plugin.

The plugin inlines its sound into the browser bundle, so the sound has to be
a small file of its own. This script writes `chime.wav`: two struck tones
with a decaying envelope, plain 16-bit mono PCM.

Usage:
    python3 assets/make-chime.py
"""

import math
import pathlib
import struct
import wave

ROOT = pathlib.Path(__file__).resolve().parent
TARGET = ROOT / "chime.wav"

RATE = 22050
DURATION = 0.75
NOTES = ((880.0, 0.0), (1174.7, 0.12))
AMPLITUDE = 0.42


def main() -> None:
    frames = bytearray()
    total = int(RATE * DURATION)
    for index in range(total):
        time = index / RATE
        value = 0.0
        for frequency, start in NOTES:
            elapsed = time - start
            if elapsed < 0:
                continue
            # A struck tone: a few partials with a fast decay.
            envelope = math.exp(-elapsed * 7.5)
            value += envelope * (
                math.sin(2 * math.pi * frequency * elapsed)
                + 0.5 * math.sin(2 * math.pi * frequency * 2 * elapsed)
                + 0.25 * math.sin(2 * math.pi * frequency * 3 * elapsed)
            )
        value *= AMPLITUDE / len(NOTES)
        # Fade the tail so the sound ends cleanly.
        if time > DURATION - 0.05:
            value *= (DURATION - time) / 0.05
        frames += struct.pack("<h", int(max(-1.0, min(1.0, value)) * 32767))

    with wave.open(str(TARGET), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(bytes(frames))
    print(f"wrote {TARGET} ({TARGET.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
