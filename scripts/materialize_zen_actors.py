# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from pathlib import Path

root = Path(__file__).resolve().parents[1] / "engine"
for dist in root.glob("obj-*/dist"):
  for resources in [dist / "bin", *dist.glob("*.app/Contents/Resources")]:
    for area, prefix in (("glance", "ZenGlance"), ("window-drag", "ZenWindowDrag")):
      for actor in (resources / "browser/actors").glob(f"{prefix}*.sys.mjs"):
        data = (root / "zen" / area / "actors" / actor.name).read_bytes()
        if actor.is_symlink() or actor.read_bytes() != data:
          # Content processes cannot follow development links outside the app.
          copy = actor.with_suffix(actor.suffix + ".tmp")
          copy.write_bytes(data)
          copy.replace(actor)
