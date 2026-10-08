# 42 Attendance Reminder — notes pour Claude

Extension Firefox MV3 (vanilla JS, zéro dépendance) qui prévient avant que la
session d'attendance de 42 Lyon expire (logtime perdu 4 h après le dernier
badge). Dépôt : `Primoux/42-attendance-reminder`. Publiée sur AMO.

Le README décrit le fonctionnement en détail ; ce fichier ne garde que ce qui
ne se déduit pas du code et l'état d'avancement.

## Travailler avec l'utilisateur

- Échanges en français. Notes AMO (release notes, notes au relecteur) en anglais.
- Donner des étapes numérotées et dire explicitement, à chaque étape, quoi faire
  et quoi renvoyer (« colle ici la ligne qui commence par … »).
- Claude ne peut pas lancer Firefox ni atteindre attendance (connexion 42
  requise). Tout comportement réel se vérifie en lui faisant coller la console,
  ou le résultat d'une ligne de JS à coller. Toujours dire ce qui n'a pas été
  vérifié en vrai.

## Commandes

```sh
npm test         # version:check + parser, background, content
npm run lint     # web-ext lint, exige Node >= 20 ; 2 warnings connus (voir plus bas)
npm run build    # web-ext-artifacts/42-attendance-reminder.zip
```

`gh` est installé dans `~/.local/bin` (pas de sudo sur la machine) et connecté
au compte `Primoux`.

## Flux de travail

- Une branche et une PR par changement, base `main`. Merge en `--rebase
  --delete-branch` (historique linéaire), après accord de l'utilisateur et, pour
  tout ce qui touche au comportement ou au rendu, après son test dans Firefox.
- Messages de commit en français, verbe au présent (« Ajoute », « Corrige »,
  « Passe la version en X »), avec un corps qui dit pourquoi.
- La CI (`.github/workflows/ci.yml`, Node 20) lance test, lint et build.
- Version dupliquée dans `manifest.json` et `package.json` ; `version:check`
  casse si elles divergent. AMO refuse à jamais un numéro déjà envoyé : tout
  correctif après un envoi demande un nouveau numéro.
- Le zip liste ses fichiers dans le script `build` : un nouveau fichier
  d'extension doit y être ajouté. Tests, README et ce fichier n'y sont pas.

## Tester dans Firefox

1. `about:debugging#/runtime/this-firefox` → « Charger un module temporaire » →
   `manifest.json`, ou « Actualiser » après une modif, puis recharger l'onglet
   attendance.
2. Console de la page (F12) : logs `[42 Reminder]` du content script.
   « Inspecter » dans `about:debugging` : logs `[42 Reminder/bg]`.
3. Activer les logs (pas de champ dans le popup, volontairement) depuis la
   console du background :

```js
browser.storage.local.get('settings').then(({ settings }) =>
  browser.storage.local.set({ settings: { ...settings, debug: true } }));
```

`testMode: true` de la même façon : le préavis du popup passe en secondes.

Un module temporaire n'a pas forcément l'accès au site : si
`permissions.contains` rend `false`, tout fetch du background échoue en CORS.
Le popup affiche alors un bouton « Autoriser l'accès ».

## Ce qu'on sait de la page attendance

Relevé sur `attendance.42lyon.fr/me` en octobre 2026 (application SvelteKit,
`v1.12.0`). Tout ça peut changer sans prévenir.

- **La page ne se met pas à jour après un badge.** Seul son compte à rebours
  défile. Sans relecture, un rebadge n'était vu qu'après F5.
- **En-tête** : `session expires at 04:43` puis `03h 44m`. C'est la seule
  source fiable de l'échéance, et elle est en heure locale même dans la
  réponse brute du serveur.
- **Lignes de présence** : `On Site 00:00 00:43 00:43` (début, fin, durée) et
  `On Site Unsaved 00:43 00:58 00:15` pour la présence en cours, dont la fin
  suit l'horloge. Les présences sont coupées à minuit.
- **La réponse brute du serveur (SSR) donne ces lignes en UTC** : un badge de
  00:55 y apparaît `22:55`, le jour `6 Tuesday` au lieu de `7 Wednesday`. Le
  navigateur les repasse en local à l'hydratation. D'où `detectRemote`, qui ne
  lit que l'échéance dans une réponse relue.
- **Faux amis** : des durées et totaux ressemblent à des heures (`13:37 /
  154:00` total du mois, `+ 00:15 00:58` total du jour, axes `04:00 08:00`).
  Un total peut coller à l'horloge par coïncidence et faire gagner un gros
  conteneur dans `scoreCandidate`.
- Déconnecté, `/me` répond 303 vers la connexion 42.

## Décisions prises

- **Les alertes ne dépendent que de l'échéance.** L'heure de début (« depuis
  … ») est de l'affichage ; elle est approximative juste après un rebadge et
  autour de minuit, et le background garde la plus ancienne reçue pendant la
  session.
- **Relecture du serveur** par `content.js` quand un onglet est ouvert, par
  `background.js` (`readServer`) quand aucun onglet ne s'est manifesté depuis
  2 min. Cadence : 5 min en session, 1 min près du préavis, 15 min sans session
  (repérer un premier badge sans ouvrir attendance). Ce dernier point sollicite
  le serveur du campus ~96 fois par jour et par utilisateur : choix assumé,
  réglable via `IDLE_REFRESH_MS`.
- **Aucune permission `cookies`** : Firefox joint la session 42 aux requêtes
  dès que la permission d'hôte est accordée.
- **Une échéance à plus de 4 h dans le futur est une échéance passée** (page
  restée ouverte), pas celle du lendemain.
- **Pas de `<details>` dans le popup** : Firefox ne redimensionne pas la
  fenêtre à l'ouverture. `debug` et `testMode` sont sortis du popup.
- Les 2 warnings du lint (`strict_min_version` 115 vs
  `data_collection_permissions` pris en charge à partir de 140) sont laissés :
  AMO exige la clé, et relever le minimum exclurait des utilisateurs.

## Avancement

| Version | Contenu | État au 2026-10-07 |
|---|---|---|
| 1.1.0 | cycle de session et notifications fiabilisés | remplacée |
| 1.2.0 | rebadge vu sans F5 (relecture par l'onglet), session fantôme corrigée | remplacée |
| 1.3.0 | suivi sans onglet, accès au site manquant signalé | en ligne sur AMO |
| 1.3.1 | réglages avancés retirés du popup (débordement) | envoyée, en attente de validation |

État lu sur la page développeur AMO (« Listed Version » / « Next Listed
Version »). La fiche du module a une description en anglais (langue par défaut)
et en français, à tenir à jour quand le comportement change.

Pas encore vérifié en vrai : un rebadge fait onglet attendance fermé (la
relecture du background lit bien l'échéance, le rebadge lui-même n'a pas été
observé).

## Pistes

1. Relire la page dès que l'onglet redevient visible, pour voir un rebadge
   sans attendre jusqu'à 5 min.
2. Fiabiliser l'heure de début : écrire des tests sur le texte réel de la page
   (ci-dessus) et resserrer `scoreCandidate`.
3. Signaler dans le popup quand le suivi est aveugle : déconnecté d'attendance
   et aucun onglet ouvert.
4. Supprimer les branches `dev` et `origin/fiabilise-sessions-et-notifications`
   si l'utilisateur confirme qu'elles ne servent plus (`dev` a divergé de `main`).
5. Portage Chrome : `background.scripts` est propre à Firefox, et un service
   worker n'a pas de `DOMParser` (il faudrait un document offscreen pour
   `readServer`).
