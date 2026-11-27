#!/usr/bin/env python3
# <bitbar.title>EnergIA</bitbar.title>
# <bitbar.version>v0.1</bitbar.version>
# <bitbar.desc>Ce que représente mon usage de l'IA : énergie du jour dans la barre de menus, tableau de bord au clic.</bitbar.desc>
# <bitbar.dependencies>python3</bitbar.dependencies>
# <swiftbar.type>streamable</swiftbar.type>
# <swiftbar.persistentWebView>true</swiftbar.persistentWebView>
"""Point d'entrée. Sans argument : plugin SwiftBar (macOS), lancé par SwiftBar
par un lien symbolique, d'où le vrai dossier retrouvé à partir du chemin résolu.
Avec --serve : serveur seul, sur n'importe quel système, qui ouvre le tableau
de bord dans le navigateur (python3 EnergIA.py --serve)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "menubar"))

from server import main  # noqa: E402

main()
