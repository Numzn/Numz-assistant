#!/usr/bin/env python3
"""A test application for the desktop verification: one window that draws coloured bands from a file, and draws them again when the file
changes. Each line of the file is `RRGGBB top bottom` in window coordinates (either may be outside the window: the band is clipped, as a
scrolled document is). It stands in for a page of content that can show one segment, several, or part of one at the edge.
Usage: bandwindow.py TITLE FILE WxH+X+Y"""
import sys
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import GLib, Gtk  # noqa: E402

title, path, geometry = sys.argv[1], sys.argv[2], sys.argv[3]
size, _, pos = geometry.partition("+")
width, height = (int(v) for v in size.split("x"))
x, _, y = pos.partition("+")

state = {"bands": []}


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


def draw(_widget, cr):
    cr.set_source_rgb(1, 1, 1)
    cr.paint()
    for colour, top, bottom in state["bands"]:
        r, g, b = (int(colour[i : i + 2], 16) / 255 for i in (0, 2, 4))
        cr.set_source_rgb(r, g, b)
        cr.rectangle(0, top, width, bottom - top)
        cr.fill()
    return False


window = Gtk.Window(title=title)
window.set_default_size(width, height)
window.set_resizable(False)
window.move(int(x), int(y))
area = Gtk.DrawingArea()
area.set_size_request(width, height)
area.connect("draw", draw)
window.add(area)


def refresh():
    bands = load()
    if bands != state["bands"]:
        state["bands"] = bands
        area.queue_draw()
    return True


refresh()
GLib.timeout_add(200, refresh)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
