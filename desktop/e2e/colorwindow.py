#!/usr/bin/env python3
"""A test application for the desktop verification: one window with a title and a solid colour. Usage: colorwindow.py TITLE '#rrggbb' WxH+X+Y"""
import sys
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gtk  # noqa: E402

title, colour, geometry = sys.argv[1], sys.argv[2], sys.argv[3]
size, _, pos = geometry.partition("+")
width, height = (int(v) for v in size.split("x"))
x, _, y = pos.partition("+")

window = Gtk.Window(title=title)
window.set_default_size(width, height)
window.set_resizable(False)
window.move(int(x), int(y))
css = Gtk.CssProvider()
css.load_from_data(f"window, box {{ background-color: {colour}; }}".encode())
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
