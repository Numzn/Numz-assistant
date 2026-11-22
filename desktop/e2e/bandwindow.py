#!/usr/bin/env python3
"""A test application for the desktop verification: one window that shows coloured bands from a file, and shows them again when the file
changes. Each line of the file is `RRGGBB top bottom` in window coordinates (either may be outside the window: the band is clipped, as a
scrolled document is). It stands in for a page of content that can show one segment, several, or part of one at the edge.
Usage: bandwindow.py TITLE FILE WxH+X+Y"""
import sys
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

title, path, geometry = sys.argv[1], sys.argv[2], sys.argv[3]
size, _, pos = geometry.partition("+")
width, height = (int(v) for v in size.split("x"))
x, _, y = pos.partition("+")

state = {"bands": None}


def load():
    bands = []
    try:
        for line in open(path, encoding="utf-8").read().splitlines():
            parts = line.split()
            if len(parts) == 3:
                bands.append((parts[0], int(parts[1]), int(parts[2])))
    except OSError:
        pass
    return bands


window = Gtk.Window(title=title)
window.set_default_size(width, height)
window.set_resizable(False)
window.move(int(x), int(y))
fixed = Gtk.Fixed()
fixed.set_size_request(width, height)
white = Gtk.CssProvider()
white.load_from_data(b"window, fixed { background-color: #ffffff; }")
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), white, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
window.add(fixed)


def refresh():
    bands = load()
    if bands != state["bands"]:
        state["bands"] = bands
        for child in fixed.get_children():
            fixed.remove(child)
        for colour, top, bottom in bands:
            # Only the part inside the window is drawn: a Fixed does not clip, and a child below its edge would make the window grow.
            top, bottom = max(top, 0), min(bottom, height)
            if bottom <= top:
                continue
            box = Gtk.Box()
            box.set_size_request(width, bottom - top)
            provider = Gtk.CssProvider()
            provider.load_from_data(("box { background-color: #%s; }" % colour).encode())
            box.get_style_context().add_provider(provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1)
            fixed.put(box, 0, top)
        fixed.show_all()
    return True


refresh()
GLib.timeout_add(200, refresh)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
