# Mentions de logiciels tiers

ROTK Launcher est distribué sous `GPL-3.0-or-later`, mais utilise des composants sous licences compatibles ou séparées. Le fichier `package-lock.json` constitue la liste exacte et verrouillée des dépendances JavaScript d’un build donné.

| Composant | Licence | Projet |
| --- | --- | --- |
| React et React DOM | MIT | <https://react.dev/> |
| Electron | MIT, avec composants Chromium/Node et leurs propres notices | <https://www.electronjs.org/> |
| Vite | MIT | <https://vite.dev/> |
| TypeScript | Apache-2.0 | <https://www.typescriptlang.org/> |
| Motion / Framer Motion | MIT | <https://motion.dev/> |
| Lucide React | ISC | <https://lucide.dev/> |
| Barlow Condensed via Fontsource | SIL OFL 1.1 | <https://fontsource.org/fonts/barlow-condensed> |
| Inter via Fontsource | SIL OFL 1.1 | <https://fontsource.org/fonts/inter> |
| Polices au choix du joueur (`resources/fonts`) : Inter, Barlow, Exo 2, Titillium Web, Open Sans | SIL OFL 1.1 ; instances statiques réduites et mises à la taille des polices du jeu par `scripts/build-player-fonts.py` | <https://github.com/google/fonts/tree/main/ofl> |
| Polices d’origine de H1Z1 : Roboto, Roboto Mono, Permanent Marker, Rock Salt, Calligraffitti (Apache-2.0) ; Montserrat, Oswald (SIL OFL 1.1). Copies identiques pour le choix « Original », mises à la taille de chaque emplacement sinon | Copyright et textes complets dans `resources/fonts/FONT-LICENSES.txt` | <https://fonts.google.com/> |
| electron-builder | MIT | <https://www.electron.build/> |
| Vitest | MIT | <https://vitest.dev/> |
| yazl, export ZIP des diagnostics | MIT, Copyright (c) 2014 Josh Wolfe | <https://github.com/thejoshwolfe/yazl> |
| buffer-crc32, contrôle CRC des archives ZIP | MIT, Copyright (c) 2013–2024 Brian J. Brennan | <https://github.com/brianloveswords/buffer-crc32> |
| Zig, utilisé pour le build natif | MIT | <https://ziglang.org/> |
| Vivox 5 client runtime | Proprietary Unity/Vivox runtime, published as a signed binary and included in official project installers | <https://unity.com/legal/licenses/unity-package-distribution-license> |

Les textes de licence livrés par les paquets sont disponibles dans `node_modules` après `npm ci`. Les distributions Electron doivent conserver les fichiers de licence et notices générés, notamment ceux de Chromium.

### Notice Lucide (ISC)

Le symbole `public/branding/rotk-mark.svg` adapte un tracé de couronne de Lucide :

> ISC License
>
> Copyright (c) 2026 Lucide Icons and Contributors
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Projet de référence

Le travail de la communauté [H1emu/h1emu-launcher](https://github.com/H1emu/h1emu-launcher), publié sous GPL-3.0, a servi de référence fonctionnelle pour les besoins généraux d’un launcher H1Z1 communautaire. ROTK Launcher reste publié sous `GPL-3.0-or-later` et conserve les obligations de copyleft applicables à toute portion dérivée.

## Client et service tiers

### Intel PresentMon (MIT)

Le mode Debug inclut l'outil console officiel [PresentMon 2.5.1](https://github.com/GameTechDev/PresentMon/releases/tag/v2.5.1), Copyright (C) 2017–2024 Intel Corporation, sous licence MIT. Le texte complet est fourni dans `resources/diagnostics/PresentMon-LICENSE.txt` et dans l'installation. Seul le collecteur console signé Intel est redistribué ; son empreinte SHA-256 est fixée par `scripts/verify-presentmon.mjs` et vérifiée à la construction, après packaging et avant exécution.

Source binaire : `PresentMon-2.5.1-x64.exe` de cette publication officielle. SHA-256 : `9bec3083069f58f911e6a512f4806db51a27bd096103087bc1d05ef54c80a191`.

Le client H1Z1 n’est pas une dépendance redistribuée : il doit être fourni localement par l’utilisateur. Ce dépôt n’inclut ni binaire, ni asset, ni code propriétaire du jeu.

This repository and official ROTK installers include the Unity-signed Vivox 5 client runtime as a binary component required by the voice-chat integration. That runtime is governed by the applicable Unity/Vivox terms and notices and is not relicensed under GPL-3.0.


Les couvertures d’actualités sont récupérées depuis `rotk.app` et ne font pas partie du code sous GPL. Consultez [ASSET_LICENSE.md](ASSET_LICENSE.md).
