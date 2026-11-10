#!/bin/sh
# Dev launcher: runs the Flatpak Zotero with the arguments zotero-plugin-scaffold
# passes (-profile, --dataDir, -start-debugger-server, ...). The dev instance uses
# its own profile and data directory under .dev/, so it runs next to the normal
# Zotero without touching ~/Zotero.
#
# MOZ_ENABLE_WAYLAND=0 runs it on Xwayland: on native Wayland, GNOME reports a
# covered window as hidden, and pdf.js then stops rendering pages, which breaks
# the reader checks in scripts/ (X11 windows only count as hidden when minimised).
# --nosocket=wayland makes the Flatpak use its X11 fallback (an explicit
# --socket=x11 is dropped while the Wayland socket is available).
exec flatpak run --nosocket=wayland --env=MOZ_ENABLE_WAYLAND=0 --command=zotero org.zotero.Zotero -no-remote "$@"
