"""Notification-area icon for Windows, used by the "server only" mode.

A lightning bolt next to the clock: its tooltip gives the day's estimated energy,
a click opens the dashboard, a right click offers "Open" and "Quit". The bolt turns
red when a threshold chosen in the page is exceeded.

Standard library only: the Win32 calls go through ctypes. `Tray` holds the logic and
talks to Windows through a small `Win32` object, which the tests replace with a fake:
the logic is tested everywhere, the real Win32 calls only run on Windows.
NOT YET TRIED ON A REAL WINDOWS MACHINE.
"""

import ctypes
import os
import threading
import time

HERE = os.path.dirname(os.path.realpath(__file__))
ICONS = {False: os.path.join(HERE, "energia.ico"), True: os.path.join(HERE, "energia-over.ico")}

TEXTS = {
    "fr": {"open": "Ouvrir le tableau de bord", "quit": "Quitter EnergIA",
           "tip": "EnergIA – {energy} aujourd'hui", "over": "EnergIA – {energy} aujourd'hui (seuil dépassé)",
           "failed": "EnergIA : l'icône de la zone de notification n'a pas pu être créée ({reason}). "
                     "Le tableau de bord reste ouvert ; arrêtez avec Ctrl+C."},
    "en": {"open": "Open the dashboard", "quit": "Quit EnergIA",
           "tip": "EnergIA – {energy} today", "over": "EnergIA – {energy} today (threshold exceeded)",
           "failed": "EnergIA: the notification-area icon could not be created ({reason}). "
                     "The dashboard stays open; stop with Ctrl+C."},
}

# Win32 constants (winuser.h, shellapi.h).
WM_NULL, WM_DESTROY, WM_CLOSE = 0x0000, 0x0002, 0x0010
WM_LBUTTONUP, WM_RBUTTONUP = 0x0202, 0x0205
WM_APP = 0x8000
TRAY_EVENT = WM_APP + 1    # sent by the icon: lParam carries the mouse message
TRAY_REFRESH = WM_APP + 2  # sent by update(), to change the icon from the window's own thread
NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP = 1, 2, 4
MENU_OPEN, MENU_QUIT = 1, 2
TIP_MAX = 127              # szTip holds 128 characters, the final zero included
OPEN_PAUSE = 1.0           # seconds: a double click must not open two tabs


def notify_struct():
    """NOTIFYICONDATAW (shellapi.h), as Windows Vista and later expect it: 976 bytes on
    64-bit Windows. Fixed-width types, so that the layout can be checked on any system
    (only the width of a character differs: 2 bytes on Windows)."""
    dword, handle, char = ctypes.c_uint32, ctypes.c_void_p, ctypes.c_wchar

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [
            ("cbSize", dword), ("hWnd", handle), ("uID", dword), ("uFlags", dword),
            ("uCallbackMessage", dword), ("hIcon", handle), ("szTip", char * 128),
            ("dwState", dword), ("dwStateMask", dword), ("szInfo", char * 256), ("uVersion", dword),
            ("szInfoTitle", char * 64), ("dwInfoFlags", dword), ("guidItem", dword * 4), ("hBalloonIcon", handle),
        ]

    return NOTIFYICONDATAW


class Win32:
    """The few Win32 calls the icon needs. Only usable on Windows."""

    def __init__(self):
        from ctypes import wintypes

        self.wintypes = wintypes
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.NOTIFYICONDATAW = notify_struct()
        result = ctypes.c_ssize_t  # LRESULT
        self.WNDPROC = ctypes.WINFUNCTYPE(result, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

        class WNDCLASSW(ctypes.Structure):
            _fields_ = [
                ("style", wintypes.UINT), ("lpfnWndProc", self.WNDPROC), ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HANDLE), ("hIcon", wintypes.HANDLE),
                ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HANDLE),
                ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR),
            ]

        self.WNDCLASSW = WNDCLASSW
        u, s, k, w = self.user32, self.shell32, self.kernel32, wintypes
        # Declared one by one: without this, 64-bit handles and pointers are cut to 32 bits.
        signatures = [
            (k.GetModuleHandleW, [w.LPCWSTR], w.HANDLE),
            (u.RegisterClassW, [ctypes.POINTER(WNDCLASSW)], w.ATOM),
            (u.CreateWindowExW, [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                 ctypes.c_int, w.HWND, w.HANDLE, w.HANDLE, w.LPVOID], w.HWND),
            (u.DefWindowProcW, [w.HWND, w.UINT, w.WPARAM, w.LPARAM], result),
            (u.DestroyWindow, [w.HWND], w.BOOL),
            (u.PostMessageW, [w.HWND, w.UINT, w.WPARAM, w.LPARAM], w.BOOL),
            (u.PostQuitMessage, [ctypes.c_int], None),
            (u.GetMessageW, [ctypes.POINTER(w.MSG), w.HWND, w.UINT, w.UINT], ctypes.c_int),
            (u.TranslateMessage, [ctypes.POINTER(w.MSG)], w.BOOL),
            (u.DispatchMessageW, [ctypes.POINTER(w.MSG)], result),
            (u.RegisterWindowMessageW, [w.LPCWSTR], w.UINT),
            (u.LoadImageW, [w.HANDLE, w.LPCWSTR, w.UINT, ctypes.c_int, ctypes.c_int, w.UINT], w.HANDLE),
            (u.LoadIconW, [w.HANDLE, w.LPVOID], w.HANDLE),
            (u.CreatePopupMenu, [], w.HANDLE),
            (u.AppendMenuW, [w.HANDLE, w.UINT, ctypes.c_size_t, w.LPCWSTR], w.BOOL),
            (u.TrackPopupMenu, [w.HANDLE, w.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.HWND, w.LPVOID], w.BOOL),
            (u.DestroyMenu, [w.HANDLE], w.BOOL),
            (u.GetCursorPos, [ctypes.POINTER(w.POINT)], w.BOOL),
            (u.SetForegroundWindow, [w.HWND], w.BOOL),
            (s.Shell_NotifyIconW, [w.DWORD, ctypes.POINTER(self.NOTIFYICONDATAW)], w.BOOL),
        ]
        for function, argtypes, restype in signatures:
            function.argtypes, function.restype = argtypes, restype
        # Explorer broadcasts this message when the taskbar is recreated (after a crash):
        # the icon then has to be added again.
        self.taskbar_created = u.RegisterWindowMessageW("TaskbarCreated")
        self._proc = None

    def create_window(self, handler):
        """A hidden window that receives the icon's messages. `handler(hwnd, msg, wparam, lparam)`."""
        self._proc = self.WNDPROC(handler)  # kept: Windows calls it for as long as the window lives
        instance = self.kernel32.GetModuleHandleW(None)
        window_class = self.WNDCLASSW()
        window_class.lpfnWndProc = self._proc
        window_class.hInstance = instance
        window_class.lpszClassName = "EnergIATray"
        if not self.user32.RegisterClassW(ctypes.byref(window_class)):
            raise ctypes.WinError(ctypes.get_last_error())
        hwnd = self.user32.CreateWindowExW(0, "EnergIATray", "EnergIA", 0, 0, 0, 0, 0, None, None, instance, None)
        if not hwnd:
            raise ctypes.WinError(ctypes.get_last_error())
        return hwnd

    def load_icon(self, path):
        IMAGE_ICON, LR_LOADFROMFILE, LR_DEFAULTSIZE = 1, 0x0010, 0x0040
        icon = self.user32.LoadImageW(None, path, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE)
        return icon or self.user32.LoadIconW(None, 32512)  # IDI_APPLICATION, the system's default icon

    def notify(self, action, hwnd, icon, tip):
        data = self.NOTIFYICONDATAW()
        data.cbSize = ctypes.sizeof(data)
        data.hWnd, data.uID = hwnd, 1
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
        data.uCallbackMessage = TRAY_EVENT
        data.hIcon = icon
        data.szTip = tip[:TIP_MAX]
        return bool(self.shell32.Shell_NotifyIconW(action, ctypes.byref(data)))

    def popup_menu(self, hwnd, items):
        """Shows a menu at the pointer; returns the chosen identifier, or 0."""
        TPM_RIGHTBUTTON, TPM_NONOTIFY, TPM_RETURNCMD = 0x0002, 0x0080, 0x0100
        menu = self.user32.CreatePopupMenu()
        for identifier, text in items:
            self.user32.AppendMenuW(menu, 0, identifier, text)  # 0: MF_STRING
        point = self.wintypes.POINT()
        self.user32.GetCursorPos(ctypes.byref(point))
        self.user32.SetForegroundWindow(hwnd)  # otherwise the menu does not close on a click elsewhere
        chosen = self.user32.TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_NONOTIFY | TPM_RETURNCMD,
                                            point.x, point.y, 0, hwnd, None)
        self.user32.PostMessageW(hwnd, WM_NULL, 0, 0)
        self.user32.DestroyMenu(menu)
        return chosen

    def post(self, hwnd, message):
        self.user32.PostMessageW(hwnd, message, 0, 0)

    def destroy(self, hwnd):
        self.user32.DestroyWindow(hwnd)

    def default(self, hwnd, message, wparam, lparam):
        return self.user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def quit_loop(self):
        self.user32.PostQuitMessage(0)

    def loop(self):
        message = self.wintypes.MSG()
        while self.user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
            self.user32.TranslateMessage(ctypes.byref(message))
            self.user32.DispatchMessageW(ctypes.byref(message))


class Tray:
    """The icon and its behaviour. Windows wants the window, the icon and the message
    loop in one thread: start() runs them in a thread of their own, so that the main
    thread stays free to receive Ctrl+C."""

    def __init__(self, lang, on_open, api=None, icons=ICONS, clock=time.monotonic):
        self.texts = TEXTS[lang]
        self.on_open, self.api, self.icons, self.clock = on_open, api, icons, clock
        self.error = None
        self.closed = threading.Event()   # set when the icon is gone: "Quit", close(), or a failure
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._hwnd = None
        self._handles = {}
        self._state = (self.texts["tip"].format(energy="…"), False)
        self._last_open = None

    def start(self, timeout=10):
        """True once the icon is shown; False if it could not be created (see `error`)."""
        threading.Thread(target=self._run, daemon=True).start()
        self._ready.wait(timeout)
        return self.error is None and self._hwnd is not None

    def _run(self):
        try:
            self.api = self.api or Win32()
            self._handles = {over: self.api.load_icon(path) for over, path in self.icons.items()}
            hwnd = self.api.create_window(self.handle)
            if not self._show(NIM_ADD, hwnd):
                raise OSError("Shell_NotifyIcon")
            self._hwnd = hwnd
            self._ready.set()
            self.api.loop()
        except Exception as error:  # the dashboard must survive a failed icon
            self.error = error
        finally:
            self._hwnd = None
            self._ready.set()
            self.closed.set()

    def _show(self, action, hwnd):
        with self._lock:
            tip, over = self._state
        return self.api.notify(action, hwnd, self._handles.get(over), tip)

    def handle(self, hwnd, message, wparam, lparam):
        """The window procedure: every message Windows sends to the hidden window."""
        try:
            if message == TRAY_EVENT:
                event = lparam & 0xFFFF
                if event == WM_LBUTTONUP:
                    self._open()
                elif event == WM_RBUTTONUP:
                    chosen = self.api.popup_menu(hwnd, [(MENU_OPEN, self.texts["open"]), (MENU_QUIT, self.texts["quit"])])
                    if chosen == MENU_OPEN:
                        self._open()
                    elif chosen == MENU_QUIT:
                        self.api.destroy(hwnd)
                return 0
            if message == TRAY_REFRESH:
                self._show(NIM_MODIFY, hwnd)
                return 0
            if message == WM_DESTROY:
                self._show(NIM_DELETE, hwnd)
                self.api.quit_loop()
                return 0
            if message == getattr(self.api, "taskbar_created", None):
                self._show(NIM_ADD, hwnd)
                return 0
        except Exception as error:  # an exception must never cross back into Windows
            self.error = error
        return self.api.default(hwnd, message, wparam, lparam)

    def _open(self):
        now = self.clock()
        if self._last_open is not None and now - self._last_open < OPEN_PAUSE:
            return
        self._last_open = now
        self.on_open()

    def update(self, energy, over):
        """New tooltip and colour; callable from any thread."""
        state = (self.texts["over" if over else "tip"].format(energy=energy), bool(over))
        with self._lock:
            if state == self._state:
                return
            self._state = state
        hwnd = self._hwnd
        if hwnd:
            self.api.post(hwnd, TRAY_REFRESH)

    def close(self):
        """Removes the icon; callable from any thread."""
        hwnd = self._hwnd
        if hwnd:
            self.api.post(hwnd, WM_CLOSE)  # the default handling of WM_CLOSE destroys the window
