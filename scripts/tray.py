#!/usr/bin/env python3
"""Life Command system-tray controller.

Implements a KDE StatusNotifierItem (+ com.canonical.dbusmenu) over D-Bus with
python3-gobject only — no extra packages. Shows live stack health (green when
web is reachable, grey when down), left-click opens the dashboard, right-click
offers start/stop/restart/status/studio. Runs as the finance-tray systemd user
service.
"""
import os
import signal
import subprocess
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CTL = os.path.join(ROOT, "scripts", "stack-ctl.sh")
APP_URL = "http://localhost:3141"
ICON_UP = "life-command-tray"
ICON_DOWN = "life-command-tray-off"
SERVICES = ["finance-supabase", "finance-web", "finance-workers"]


def load_pixmaps(state):
    """Raw ARGB32 pixmaps pre-rendered by install-desktop.sh — theme-proof.

    Returns [(w, h, bytes)] for the a(iiay) IconPixmap property, [] if the
    generated files are missing (IconName then serves as fallback).
    """
    out = []
    for size in (22, 44):
        path = os.path.join(ROOT, "assets", "tray", "gen", f"{state}-{size}.rgba")
        try:
            rgba = open(path, "rb").read()
        except OSError:
            continue
        if len(rgba) != size * size * 4:
            continue
        argb = bytearray(len(rgba))
        for i in range(0, len(rgba), 4):
            argb[i] = rgba[i + 3]      # A
            argb[i + 1] = rgba[i]      # R
            argb[i + 2] = rgba[i + 1]  # G
            argb[i + 3] = rgba[i + 2]  # B
        out.append((size, size, bytes(argb)))
    return out


PIXMAPS = {"on": load_pixmaps("on"), "off": load_pixmaps("off")}

SNI_XML = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <method name="Activate">
      <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    </method>
    <method name="SecondaryActivate">
      <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    </method>
    <method name="ContextMenu">
      <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    </method>
    <method name="Scroll">
      <arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/>
    </method>
    <signal name="NewIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg type="s"/></signal>
  </interface>
</node>
"""

MENU_XML = """
<node>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg type="i" name="parentId" direction="in"/>
      <arg type="i" name="recursionDepth" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="u" name="revision" direction="out"/>
      <arg type="(ia{sv}av)" name="layout" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg type="ai" name="ids" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="a(ia{sv})" name="properties" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="name" direction="in"/>
      <arg type="v" name="value" direction="out"/>
    </method>
    <method name="Event">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="eventId" direction="in"/>
      <arg type="v" name="data" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg type="a(isvu)" name="events" direction="in"/>
      <arg type="ai" name="idErrors" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg type="i" name="id" direction="in"/>
      <arg type="b" name="needUpdate" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg type="ai" name="ids" direction="in"/>
      <arg type="ab" name="updatesNeeded" direction="out"/>
      <arg type="ai" name="idErrors" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})"/><arg type="a(ias)"/></signal>
    <signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
  </interface>
</node>
"""

# (id, label, ctl-subcommand) — None label = separator
MENU_ITEMS = [
    (1, "Open Life Command", "open"),
    (2, None, None),
    (3, "Start stack", "start"),
    (4, "Stop stack (free RAM)", "stop"),
    (5, "Restart web + workers", "restart"),
    (6, None, None),
    (7, "Status notification", "status"),
    (8, "Supabase Studio", "studio"),
    (9, None, None),
    (10, "Quit Life Command", None),  # closes the app window AND the tray
]


class Tray:
    def __init__(self):
        self.loop = GLib.MainLoop()
        self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.bus_name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        self.icon = ICON_DOWN
        self.tooltip_text = "checking…"
        self.revision = 1

        sni_node = Gio.DBusNodeInfo.new_for_xml(SNI_XML)
        menu_node = Gio.DBusNodeInfo.new_for_xml(MENU_XML)
        self.conn.register_object(
            "/StatusNotifierItem", sni_node.interfaces[0],
            self.sni_method, self.sni_get_property, None,
        )
        self.conn.register_object(
            "/MenuBar", menu_node.interfaces[0],
            self.menu_method, self.menu_get_property, None,
        )

        Gio.bus_own_name_on_connection(
            self.conn, self.bus_name, Gio.BusNameOwnerFlags.NONE, None, None
        )
        # Register now and whenever the watcher (plasmashell) restarts.
        Gio.bus_watch_name_on_connection(
            self.conn, "org.kde.StatusNotifierWatcher",
            Gio.BusNameWatcherFlags.NONE,
            lambda *_: self.register_with_watcher(), None,
        )

        self.refresh()
        GLib.timeout_add_seconds(30, self.refresh)

    # ---- stack state ---------------------------------------------------------

    def run_ctl(self, sub):
        subprocess.Popen(
            ["/usr/bin/bash", CTL, sub],
            start_new_session=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        # actions change state — re-check soon after
        for delay in (3, 12):
            GLib.timeout_add_seconds(delay, lambda: (self.refresh(), False)[1])

    def refresh(self):
        try:
            r = subprocess.run(
                ["systemctl", "--user", "is-active", *SERVICES],
                capture_output=True, text=True, timeout=5,
            )
            states = r.stdout.split() or ["unknown"] * len(SERVICES)
            web_up = subprocess.run(
                ["curl", "-fsS", "-o", "/dev/null", "--max-time", "2", f"{APP_URL}/login"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            ).returncode == 0
        except Exception:
            states, web_up = ["error"], False

        icon = ICON_UP if web_up else ICON_DOWN
        pairs = ", ".join(f"{s.split('-')[1]}: {st}" for s, st in zip(SERVICES, states))
        tooltip = f"web {'up' if web_up else 'down'} — {pairs}"

        if (icon, tooltip) != (self.icon, self.tooltip_text):
            self.icon, self.tooltip_text = icon, tooltip
            self.emit_sni("NewIcon")
            self.emit_sni("NewToolTip")
        return True

    def emit_sni(self, signal_name, args=None):
        self.conn.emit_signal(
            None, "/StatusNotifierItem", "org.kde.StatusNotifierItem",
            signal_name, args,
        )

    def register_with_watcher(self):
        try:
            self.conn.call_sync(
                "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
                "org.kde.StatusNotifierWatcher", "RegisterStatusNotifierItem",
                GLib.Variant("(s)", (self.bus_name,)),
                None, Gio.DBusCallFlags.NONE, -1, None,
            )
        except GLib.Error as e:
            print(f"[tray] watcher registration failed: {e.message}", file=sys.stderr)

    # ---- org.kde.StatusNotifierItem -----------------------------------------

    def sni_get_property(self, conn, sender, path, iface, name):
        state = "on" if self.icon == ICON_UP else "off"
        # Plasma prefers IconName and shows a blank placeholder when it can't
        # resolve it — it never falls back to IconPixmap. So when pixmaps are
        # available, advertise no name at all and serve pixels only.
        icon_name = "" if PIXMAPS[state] else self.icon
        props = {
            "Category": GLib.Variant("s", "ApplicationStatus"),
            "Id": GLib.Variant("s", "life-command"),
            "Title": GLib.Variant("s", "Life Command"),
            "Status": GLib.Variant("s", "Active"),
            "IconName": GLib.Variant("s", icon_name),
            "IconPixmap": GLib.Variant("a(iiay)", PIXMAPS[state]),
            "IconThemePath": GLib.Variant("s", os.path.join(ROOT, "assets", "tray")),
            "OverlayIconName": GLib.Variant("s", ""),
            "AttentionIconName": GLib.Variant("s", ""),
            "ToolTip": GLib.Variant(
                "(sa(iiay)ss)", (icon_name, [], "Life Command", self.tooltip_text)
            ),
            "ItemIsMenu": GLib.Variant("b", False),
            "Menu": GLib.Variant("o", "/MenuBar"),
            "WindowId": GLib.Variant("i", 0),
        }
        return props.get(name)

    def sni_method(self, conn, sender, path, iface, method, params, invocation):
        if method == "Activate":
            self.run_ctl("open")
        elif method == "SecondaryActivate":
            self.run_ctl("status")
        invocation.return_value(None)

    # ---- com.canonical.dbusmenu ---------------------------------------------

    @staticmethod
    def item_props(item_id):
        label = next((l for i, l, _ in MENU_ITEMS if i == item_id), None)
        if label is None:
            return {"type": GLib.Variant("s", "separator")}
        return {
            "label": GLib.Variant("s", label),
            "enabled": GLib.Variant("b", True),
            "visible": GLib.Variant("b", True),
        }

    def menu_get_property(self, conn, sender, path, iface, name):
        props = {
            "Version": GLib.Variant("u", 3),
            "TextDirection": GLib.Variant("s", "ltr"),
            "Status": GLib.Variant("s", "normal"),
            "IconThemePath": GLib.Variant("as", []),
        }
        return props.get(name)

    def dispatch(self, item_id):
        sub = next((s for i, _, s in MENU_ITEMS if i == item_id), None)
        if item_id == 10:
            # Quit = close the app window, then stop this service (a plain
            # process exit would auto-restart under Restart=always).
            subprocess.Popen(
                ["/usr/bin/bash", CTL, "close"],
                start_new_session=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            subprocess.Popen(
                ["systemctl", "--user", "stop", "finance-tray"],
                start_new_session=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        elif sub:
            self.run_ctl(sub)

    def menu_method(self, conn, sender, path, iface, method, params, invocation):
        if method == "GetLayout":
            children = [
                GLib.Variant("(ia{sv}av)", (i, self.item_props(i), []))
                for i, _, _ in MENU_ITEMS
            ]
            root = (0, {"children-display": GLib.Variant("s", "submenu")}, children)
            invocation.return_value(
                GLib.Variant("(u(ia{sv}av))", (self.revision, root))
            )
        elif method == "GetGroupProperties":
            ids = params.unpack()[0] or [i for i, _, _ in MENU_ITEMS]
            result = [(i, self.item_props(i)) for i in ids]
            invocation.return_value(GLib.Variant("(a(ia{sv}))", (result,)))
        elif method == "GetProperty":
            item_id, prop = params.unpack()
            value = self.item_props(item_id).get(prop, GLib.Variant("s", ""))
            invocation.return_value(GLib.Variant("(v)", (value,)))
        elif method == "Event":
            item_id, event_id, _, _ = params.unpack()
            if event_id == "clicked":
                self.dispatch(item_id)
            invocation.return_value(None)
        elif method == "EventGroup":
            for item_id, event_id, _, _ in params.unpack()[0]:
                if event_id == "clicked":
                    self.dispatch(item_id)
            invocation.return_value(GLib.Variant("(ai)", ([],)))
        elif method == "AboutToShow":
            self.refresh()
            invocation.return_value(GLib.Variant("(b)", (False,)))
        elif method == "AboutToShowGroup":
            invocation.return_value(GLib.Variant("(abai)", ([], [])))
        else:
            invocation.return_value(None)

    def run(self):
        signal.signal(signal.SIGTERM, lambda *_: self.loop.quit())
        signal.signal(signal.SIGINT, lambda *_: self.loop.quit())
        self.loop.run()


if __name__ == "__main__":
    Tray().run()
