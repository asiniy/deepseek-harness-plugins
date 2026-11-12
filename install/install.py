#!/usr/bin/env python3
"""Install a plugin of this repository into a Harness profile.

A plugin is installed the way `pnpm add` would do it:

  1. link the package into <profile>/node_modules/@<scope>/<name>
  2. record it in the profile manifest (dependencies + dsh.profile.bundles)

The npm registry is unreachable from this machine and pnpm is not installed,
so the link is made by hand. The profile manifest is written atomically, so
the running Host's watcher never reads a partial file. The Host composes the
profile at boot: restart `dsh web` afterwards.

Usage:
    python3 install/install.py composer-code
    python3 install/install.py composer-code --profile ~/.dsh/profiles/web
"""

import argparse
import json
import os
import pathlib
import shutil

REPOSITORY = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_PROFILE = pathlib.Path.home() / ".dsh" / "profiles" / "web"

# Plugin folder -> package name. The scope of a package is its own name.
PACKAGES = {
    "composer-code": "@local/composer-code",
    "turn-sound": "@local/turn-sound",
    "session-unread": "@local/session-unread",
    "chrome": "@local/chrome",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plugin", choices=sorted(PACKAGES), help="the plugin folder to install")
    parser.add_argument("--profile", type=pathlib.Path, default=DEFAULT_PROFILE, help="the profile directory")
    args = parser.parse_args()

    name = PACKAGES[args.plugin]
    target = REPOSITORY / args.plugin
    if not target.is_dir():
        raise SystemExit(f"{target} is missing")

    scope, _, package = name.partition("/")
    link_dir = args.profile / "node_modules" / scope
    link = link_dir / package
    link_dir.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        link.unlink()
    elif link.is_dir():
        # A previous install left a copy behind (pnpm installs a file:
        # dependency as a copy); the repository is the source of truth now.
        shutil.rmtree(link)
    elif link.exists():
        link.unlink()
    link.symlink_to(target)
    print(f"linked {link} -> {target}")

    manifest_path = args.profile / "package.json"
    with manifest_path.open(encoding="utf-8") as handle:
        manifest = json.load(handle)

    relative = os.path.relpath(target, args.profile)
    manifest.setdefault("dependencies", {})[name] = f"file:{relative}"
    bundles = manifest.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
    if name not in bundles:
        bundles.append(name)

    mode = manifest_path.stat().st_mode & 0o777
    temporary = manifest_path.with_suffix(".json.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    os.chmod(temporary, mode)
    os.replace(temporary, manifest_path)
    print(f"updated {manifest_path}")


if __name__ == "__main__":
    main()
