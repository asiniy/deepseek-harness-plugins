#!/usr/bin/env python3
"""Build `client.js` from `client.source.js` and the packaged sound.

The browser bundle must carry the sound itself: the plugin asset route only
serves image formats, and the Web UI's plugin bundle route has no place for a
binary payload. This script inlines the sound in `assets/` as a base64 data
URI into the placeholder in `client.source.js` and writes `client.js`.

The packaged sound is `assets/aoe2-attack.mp3`; drop another audio file into
`assets/` and it is picked up instead (`assets/make-chime.py` writes a
generated chime for that).

Usage:
    python3 build-client.py
"""

import base64
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SOURCE = ROOT / "client.source.js"
TARGET = ROOT / "client.js"
PLACEHOLDER = "__SOUND_DATA_URI__"
MIME_BY_SUFFIX = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg"}


def packaged_sound() -> pathlib.Path:
    """The sound file in `assets/`: the packaged one, or any other audio."""
    preferred = ROOT / "assets" / "aoe2-attack.mp3"
    if preferred.exists():
        return preferred
    sounds = sorted(path for path in (ROOT / "assets").iterdir() if path.suffix.lower() in MIME_BY_SUFFIX)
    if not sounds:
        raise SystemExit("no sound file in assets/")
    return sounds[0]


def main() -> None:
    template = SOURCE.read_text(encoding="utf-8")
    if PLACEHOLDER not in template:
        raise SystemExit(f"{SOURCE.name} has no {PLACEHOLDER} placeholder")

    sound = packaged_sound()
    mime = MIME_BY_SUFFIX[sound.suffix.lower()]
    payload = base64.b64encode(sound.read_bytes()).decode("ascii")
    data_uri = f"data:{mime};base64,{payload}"

    # Only the constant is replaced: the comment names the placeholder too,
    # and the sound would be embedded twice.
    built = template.replace(f"'{PLACEHOLDER}'", f"'{data_uri}'")
    TARGET.write_text(built, encoding="utf-8")
    print(f"wrote {TARGET} ({len(built)} bytes, sound {sound.name}, {len(payload)} base64 chars)")


if __name__ == "__main__":
    main()
