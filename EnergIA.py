#!/usr/bin/env python3
# <bitbar.title>EnergIA</bitbar.title>
# <bitbar.version>v0.1</bitbar.version>
# <bitbar.desc>What my AI usage amounts to: today's energy in the menu bar, dashboard on click.</bitbar.desc>
# <bitbar.dependencies>python3</bitbar.dependencies>
# <swiftbar.type>streamable</swiftbar.type>
# <swiftbar.persistentWebView>true</swiftbar.persistentWebView>
"""Entry point. With no argument: SwiftBar plugin (macOS), launched by SwiftBar
through a symbolic link, hence the real folder found from the resolved path.
With --serve: server only, on any system, which opens the dashboard in the
browser (python3 EnergIA.py --serve)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "menubar"))

from server import main  # noqa: E402

main()
