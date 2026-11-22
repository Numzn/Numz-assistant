#!/usr/bin/env python3
"""A test application for the desktop verification: one window that shows the text of a file in a normal-sized monospace font, and shows it
again whenever the file changes. Used to change one digit, one word or one token of code on an otherwise unchanged screen.
Usage: textwindow.py TITLE FILE WxH+X+Y"""
import sys
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

title, path, geometry = sys.argv[1], sys.argv[2], sys.argv[3]
size, _, pos = geometry.partition("+")
width, height = (int(v) for v in size.split("x"))
x, _, y = pos.partition("+")

window = Gtk.Window(title=title)
window.set_default_size(width, height)
window.set_resizable(False)
window.move(int(x), int(y))
label = Gtk.Label()
label.set_xalign(0)
label.set_yalign(0)
label.set_margin_top(12)
label.set_margin_start(16)
window.add(label)
css = Gtk.CssProvider()
css.load_from_data(b"window { background-color: #f6f6f4; } label { color: #1c1c1e; font-family: monospace; font-size: 15px; }")
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
shown = {"text": None}


def refresh():
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        text = ""
    if text != shown["text"]:
        shown["text"] = text
        label.set_text(text)
    return True


refresh()
GLib.timeout_add(200, refresh)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
