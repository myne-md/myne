#!/usr/bin/env python3
"""Send a real WM_DELETE_WINDOW to an X window (myne-md/myne#555).

WHY THIS EXISTS, because a one-line alternative looks like it should work and
does not.

`xdotool windowclose` is the obvious tool and the wrong one. It calls
XDestroyWindow: the X server tears the window down, GTK sees a window that is
already gone, and no `delete-event` is ever raised — so tao raises no
`CloseRequested` and the app's close handler never runs. The app still exits,
which is what makes the mistake expensive: every outward sign of a graceful
close is present.

Measured rather than assumed. `strings` over the image's `libxdo.so.3` contains
neither `WM_DELETE_WINDOW` nor `WM_PROTOCOLS`, and a probe write injected into
`Editor.tsx`'s `onCloseRequested` handler did not land after an
`xdotool windowclose` — the handler is simply not reached.

`wmctrl -c` is the other candidate and is also wrong here: it asks the WINDOW
MANAGER to close the window (`_NET_CLOSE_WINDOW` to the root), and under xvfb
there is no window manager to ask.

What a title-bar X actually does is send a `WM_PROTOCOLS` ClientMessage whose
first data word is the `WM_DELETE_WINDOW` atom. That needs no window manager —
it goes straight to the window — and it is what GTK turns into `delete-event`
and tao into `CloseRequested`. Twenty lines of Xlib, reached through ctypes so
the image needs no package it does not already have (python3 and libX11.so.6
are both present).

    python3 wm-delete-window.py <decimal-window-id>

Exits non-zero with a message on stderr if the display cannot be opened, the
atoms cannot be interned, or `XSendEvent` reports failure.
"""

import ctypes
import ctypes.util
import sys

CLIENT_MESSAGE = 33


class _Data(ctypes.Union):
    _fields_ = [
        ("b", ctypes.c_char * 20),
        ("s", ctypes.c_short * 10),
        ("l", ctypes.c_long * 5),
    ]


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data", _Data),
    ]


class XEvent(ctypes.Union):
    # An XEvent is a union whose largest member is 24 longs. Declaring the
    # client-message struct alongside that padding is what keeps XSendEvent from
    # reading past the end of the buffer.
    _fields_ = [
        ("type", ctypes.c_int),
        ("xclient", XClientMessageEvent),
        ("pad", ctypes.c_long * 24),
    ]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: wm-delete-window.py <decimal-window-id>", file=sys.stderr)
        return 2
    try:
        window = int(sys.argv[1])
    except ValueError:
        print(f"not a decimal window id: {sys.argv[1]!r}", file=sys.stderr)
        return 2

    path = ctypes.util.find_library("X11") or "libX11.so.6"
    x11 = ctypes.cdll.LoadLibrary(path)
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XSendEvent.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.c_int,
        ctypes.c_long,
        ctypes.POINTER(XEvent),
    ]
    x11.XFlush.argtypes = [ctypes.c_void_p]

    display = x11.XOpenDisplay(None)
    if not display:
        print("cannot open the X display (is DISPLAY set?)", file=sys.stderr)
        return 1

    protocols = x11.XInternAtom(display, b"WM_PROTOCOLS", False)
    delete = x11.XInternAtom(display, b"WM_DELETE_WINDOW", False)
    if protocols == 0 or delete == 0:
        print("could not intern WM_PROTOCOLS / WM_DELETE_WINDOW", file=sys.stderr)
        return 1

    event = XEvent()
    event.xclient.type = CLIENT_MESSAGE
    event.xclient.send_event = True
    event.xclient.display = display
    event.xclient.window = window
    event.xclient.message_type = protocols
    event.xclient.format = 32
    event.xclient.data.l[0] = delete
    event.xclient.data.l[1] = 0  # CurrentTime

    # No event mask: a ClientMessage sent with an empty mask goes to the client
    # that created the window, which is exactly the delivery a title-bar X uses.
    if x11.XSendEvent(display, window, False, 0, ctypes.byref(event)) == 0:
        print(f"XSendEvent failed for window {window}", file=sys.stderr)
        return 1
    x11.XFlush(display)
    return 0


if __name__ == "__main__":
    sys.exit(main())
