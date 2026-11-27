#!/bin/sh
# Installe EnergIA en une commande (macOS et Linux) :
#
#   curl -fsSL https://raw.githubusercontent.com/darkxander/EnergIA/main/install.sh | sh
#
# Ce que fait ce script, sans droits d'administrateur :
#   1. copie EnergIA dans ~/.local/share/EnergIA (avec git s'il est là, sinon en
#      téléchargeant l'archive du dépôt) ; relancé, il met cette copie à jour ;
#   2. crée la commande « energia » dans ~/.local/bin, qui ouvre le tableau de bord
#      dans le navigateur (mode serveur seul) ;
#   3. sous macOS, relie le plugin au dossier de plugins de SwiftBar. Si SwiftBar
#      manque et que Homebrew est présent, il l'installe avec Homebrew.
#
# Pour désinstaller :   sh install.sh --uninstall
# (ou la même commande curl, suivie de « -s -- --uninstall »). Les compteurs et les
# réglages ne sont pas effacés.
#
# Variables facultatives : ENERGIA_HOME (dossier d'installation), ENERGIA_BIN_DIR
# (dossier de la commande), ENERGIA_PLUGIN_DIR (dossier de plugins SwiftBar),
# ENERGIA_REPO (dépôt git), ENERGIA_ARCHIVE (archive .tar.gz), ENERGIA_FORCE=1
# (remplacer un plugin EnergIA déjà relié ailleurs), ENERGIA_NO_SWIFTBAR=1.

set -eu

HOME_DIR="${ENERGIA_HOME:-$HOME/.local/share/EnergIA}"
BIN_DIR="${ENERGIA_BIN_DIR:-$HOME/.local/bin}"
REPO="${ENERGIA_REPO:-https://github.com/darkxander/EnergIA.git}"
ARCHIVE="${ENERGIA_ARCHIVE:-https://github.com/darkxander/EnergIA/archive/refs/heads/main.tar.gz}"
SWIFTBAR_ID="com.ameba.SwiftBar"

case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  fr*) FR=1 ;;
  *) FR=0 ;;
esac

# say "texte français" "English text"
say() {
  if [ "$FR" = 1 ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi
}

fail() {
  say "Erreur : $1" "Error: $2" >&2
  exit 1
}

# Ne supprime qu'un dossier qui est bien une copie d'EnergIA.
is_ours() {
  [ -f "$1/EnergIA.py" ] && [ -d "$1/menubar" ] && [ -f "$1/index.html" ]
}

plugin_dir() {
  if [ -n "${ENERGIA_PLUGIN_DIR:-}" ]; then
    printf '%s\n' "$ENERGIA_PLUGIN_DIR"
  else
    /usr/bin/defaults read "$SWIFTBAR_ID" PluginDirectory 2>/dev/null || true
  fi
}

uninstall() {
  if [ "$(uname -s)" = Darwin ]; then
    plugins="$(plugin_dir)"
    link="$plugins/EnergIA.py"
    if [ -n "$plugins" ] && [ -L "$link" ] && [ "$(readlink "$link")" = "$HOME_DIR/EnergIA.py" ]; then
      rm "$link"
      say "Plugin retiré de SwiftBar : $link" "Plugin removed from SwiftBar: $link"
    fi
  fi
  if [ -f "$BIN_DIR/energia" ] && grep -q "$HOME_DIR/EnergIA.py" "$BIN_DIR/energia" 2>/dev/null; then
    rm "$BIN_DIR/energia"
    say "Commande retirée : $BIN_DIR/energia" "Command removed: $BIN_DIR/energia"
  fi
  if [ -d "$HOME_DIR" ]; then
    is_ours "$HOME_DIR" || fail "$HOME_DIR ne ressemble pas à une copie d'EnergIA : rien n'est supprimé." \
      "$HOME_DIR does not look like a copy of EnergIA: nothing is deleted."
    rm -rf "$HOME_DIR"
    say "Dossier supprimé : $HOME_DIR" "Folder deleted: $HOME_DIR"
  fi
  say "EnergIA est désinstallée. Les compteurs et les réglages sont conservés." \
    "EnergIA is uninstalled. Counters and settings are kept."
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi
[ -z "${1:-}" ] || fail "option inconnue : $1 (seule --uninstall existe)." "unknown option: $1 (only --uninstall exists)."

# ---------- Python ----------

command -v python3 >/dev/null 2>&1 || fail "python3 est introuvable. Installez Python 3.9 ou plus récent, puis relancez." \
  "python3 was not found. Install Python 3.9 or later, then run this again."
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null \
  || fail "Python 3.9 ou plus récent est nécessaire (python3 est plus ancien, ou n'est pas encore installé)." \
    "Python 3.9 or later is required (python3 is older, or not installed yet)."

# ---------- Les fichiers ----------

if [ -d "$HOME_DIR/.git" ]; then
  say "Mise à jour d'EnergIA dans ${HOME_DIR}…" "Updating EnergIA in ${HOME_DIR}…"
  git -C "$HOME_DIR" pull --ff-only --quiet
else
  if [ -e "$HOME_DIR" ]; then
    is_ours "$HOME_DIR" || fail "$HOME_DIR existe déjà et n'est pas une copie d'EnergIA." \
      "$HOME_DIR already exists and is not a copy of EnergIA."
    rm -rf "$HOME_DIR"
  fi
  say "Installation d'EnergIA dans ${HOME_DIR}…" "Installing EnergIA in ${HOME_DIR}…"
  mkdir -p "$(dirname "$HOME_DIR")"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --quiet "$REPO" "$HOME_DIR"
  else
    # Sans git : Python télécharge l'archive du dépôt et l'extrait.
    python3 - "$ARCHIVE" "$HOME_DIR" <<'PYTHON'
import io, os, sys, tarfile, urllib.request

url, target = sys.argv[1], sys.argv[2]
with urllib.request.urlopen(url, timeout=60) as response:
    data = response.read()
os.makedirs(target)
with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
    for member in archive.getmembers():
        # L'archive range tout dans un dossier « EnergIA-main » : on l'enlève.
        parts = member.name.split("/", 1)
        if len(parts) < 2 or not parts[1] or not (member.isfile() or member.isdir()):
            continue
        path = os.path.normpath(os.path.join(target, parts[1]))
        if not path.startswith(os.path.join(target, "")):
            continue  # jamais en dehors du dossier d'installation
        if member.isdir():
            os.makedirs(path, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with archive.extractfile(member) as source, open(path, "wb") as out:
            out.write(source.read())
PYTHON
  fi
fi
is_ours "$HOME_DIR" || fail "l'installation dans $HOME_DIR est incomplète." "the installation in $HOME_DIR is incomplete."
chmod +x "$HOME_DIR/EnergIA.py"

# ---------- La commande « energia » ----------

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/energia" <<LAUNCHER
#!/bin/sh
# Ouvre le tableau de bord d'EnergIA dans le navigateur (créé par install.sh).
exec python3 "$HOME_DIR/EnergIA.py" --serve "\$@"
LAUNCHER
chmod +x "$BIN_DIR/energia"
say "Commande créée : $BIN_DIR/energia" "Command created: $BIN_DIR/energia"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "  $BIN_DIR n'est pas dans votre PATH : lancez la commande par son chemin complet, ou ajoutez ce dossier au PATH." \
       "  $BIN_DIR is not in your PATH: run the command by its full path, or add this folder to your PATH." ;;
esac

# ---------- La barre de menus (macOS) ----------

swiftbar() {
  [ "${ENERGIA_NO_SWIFTBAR:-}" = 1 ] && return 0
  if [ -z "${ENERGIA_PLUGIN_DIR:-}" ] && ! /usr/bin/mdfind "kMDItemCFBundleIdentifier == '$SWIFTBAR_ID'" 2>/dev/null | grep -q . \
     && [ ! -d /Applications/SwiftBar.app ] && [ ! -d "$HOME/Applications/SwiftBar.app" ]; then
    if command -v brew >/dev/null 2>&1; then
      say "Installation de SwiftBar avec Homebrew…" "Installing SwiftBar with Homebrew…"
      brew install --cask swiftbar
    else
      say "SwiftBar n'est pas installé : la barre de menus est laissée de côté. Installez SwiftBar (https://swiftbar.app), puis relancez ce script." \
        "SwiftBar is not installed: the menu bar is skipped. Install SwiftBar (https://swiftbar.app), then run this script again."
      return 0
    fi
  fi
  plugins="$(plugin_dir)"
  if [ -z "$plugins" ]; then
    # SwiftBar n'a pas encore de dossier de plugins : on lui en donne un.
    plugins="$HOME/.config/swiftbar"
    /usr/bin/defaults write "$SWIFTBAR_ID" PluginDirectory "$plugins"
    say "Dossier de plugins de SwiftBar réglé sur $plugins" "SwiftBar plugin folder set to $plugins"
  fi
  mkdir -p "$plugins"
  link="$plugins/EnergIA.py"
  if [ -e "$link" ] || [ -L "$link" ]; then
    current="$(readlink "$link" 2>/dev/null || true)"
    if [ "$current" != "$HOME_DIR/EnergIA.py" ] && [ "${ENERGIA_FORCE:-}" != 1 ]; then
      say "Un plugin EnergIA est déjà relié à SwiftBar (${current:-fichier}) : il est laissé tel quel. Relancez avec ENERGIA_FORCE=1 pour le remplacer." \
        "An EnergIA plugin is already linked to SwiftBar (${current:-file}): it is left as it is. Run again with ENERGIA_FORCE=1 to replace it."
      return 0
    fi
    rm -f "$link"
  fi
  ln -s "$HOME_DIR/EnergIA.py" "$link"
  say "Plugin relié à SwiftBar : $link" "Plugin linked to SwiftBar: $link"
  if [ -z "${ENERGIA_PLUGIN_DIR:-}" ]; then
    /usr/bin/open -g -a SwiftBar 2>/dev/null || true
    /usr/bin/open -g "swiftbar://refreshallplugins" 2>/dev/null || true
  fi
}

if [ "$(uname -s)" = Darwin ]; then
  swiftbar
fi

say "EnergIA est installée. Pour ouvrir le tableau de bord : energia" \
  "EnergIA is installed. To open the dashboard: energia"
