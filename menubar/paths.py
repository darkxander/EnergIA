"""Folders used by EnergIA, depending on the system.

macOS: ~/Library; Windows: %APPDATA% and %LOCALAPPDATA%; Linux and others:
XDG folders (~/.config, ~/.cache). The Claude Code logs are in the same
place everywhere: ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects.
"""

import os
import sys


def locate(platform=None, env=None, home=None):
    """{"claudecode", "cowork", "cache", "config"}: absolute paths for this system."""
    platform = sys.platform if platform is None else platform
    env = os.environ if env is None else env
    home = os.path.expanduser("~") if home is None else home
    join = os.path.join
    if platform == "darwin":
        support = join(home, "Library", "Application Support")
        cache, config, claude_app = join(home, "Library", "Caches", "EnergIA"), join(support, "EnergIA"), join(support, "Claude")
    elif platform.startswith("win"):
        roaming = env.get("APPDATA") or join(home, "AppData", "Roaming")
        local = env.get("LOCALAPPDATA") or join(home, "AppData", "Local")
        cache, config, claude_app = join(local, "EnergIA", "Cache"), join(roaming, "EnergIA"), join(roaming, "Claude")
    else:
        xdg_config = env.get("XDG_CONFIG_HOME") or join(home, ".config")
        xdg_cache = env.get("XDG_CACHE_HOME") or join(home, ".cache")
        cache, config, claude_app = join(xdg_cache, "EnergIA"), join(xdg_config, "EnergIA"), join(xdg_config, "Claude")
    claude_code = env.get("CLAUDE_CONFIG_DIR") or join(home, ".claude")
    return {
        "claudecode": join(claude_code, "projects"),
        # Cowork sessions of the Claude desktop app.
        "cowork": join(claude_app, "local-agent-mode-sessions"),
        "cache": cache,
        "config": config,
    }


PATHS = locate()
