# Intégration launcher #82 et #83

Cette révision combine les sources de #83 (lancement, CZ et voix) avec #82 (transitions d'accroupissement). Les conflits ont été résolus dans les sources, puis la DLL a été reconstruite avec Zig 0.15.2 ; aucune ancienne DLL n'a été choisie arbitrairement.

- Proxy Vivox combiné : 73 216 octets, SHA-256 `8ab1f2379c61b81391492edb84875610ffbe4d3a8d97a180c73355d989ac27a2`.
- Marqueur : `v13-perf1`, transitions interruptibles avec cache optimisé et absence de traces disque dans le hook normal.
- Proxy gameplay de #83 conservé : SHA-256 `2c8c7d65f8410a2f05f58318978b44f08860c4f5647b5474a11bf70a0ebc0b3a`.
- Sidecars, pins launcher, vérificateurs et workflows CI/release mis à jour ensemble.

Validation locale de cette combinaison : deux compilations Vivox identiques, `build:vivox` réussi (cache, 1 571 appels au hook de transition, absence d'I/O normale, pile 32 Kio et voix/volumes), Deathcomm et typecheck réussis, 404 tests Vitest réussis / 3 opt-in ignorés, builds Electron et renderer réussis.

`npm run build` complet s'arrête sur le diagnostic CPU natif : 17/18, assertion `cpuOneCorePercent > 25`. Ce résultat ne permet pas d'annoncer un build global vert. Les autres étapes ont été exécutées séparément. Les fichiers de ce diagnostic ne sont pas modifiés par cette intégration ; ne pas en retirer l'assertion pour obtenir une validation artificielle.

La CI des PR de fork doit être autorisée par un mainteneur. L'utilisateur a demandé de lui laisser cette autorisation. La PR d'accroupissement reste en brouillon jusqu'à validation du démarrage réel et de la recette client décrite dans `CROUCH_V13_TEST_20260929.md`. Packaging, validation en jeu et publication d'une nouvelle version restent à effectuer ; aucun tag ni déploiement public n'est créé ici.

Les résultats et empreintes précédents dans `AUDIT_FIXES_20260929.md` concernent #83 seule. Pour la combinaison, utiliser les empreintes de ce document et les fichiers du commit courant. Ne pas republier la version existante : choisir une nouvelle version launcher et distribuer son paquet complet. Le second crash CZ, le tearing et le flou ne sont pas déclarés résolus.
