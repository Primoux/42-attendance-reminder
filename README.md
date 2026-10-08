# 42 Attendance Reminder

Extension Firefox qui te prévient **avant** que ta session d'attendance expire et
que tu perdes ton logtime.

Sur `attendance.42lyon.fr`, une session expire 4 h après ton dernier badge : si
tu ne rebadges pas avant, le logtime est perdu. L'extension lit l'échéance que
la page affiche et t'envoie une notification avant.

**[Installer depuis Firefox Add-ons](https://addons.mozilla.org/fr/firefox/addon/42-attendance-reminder/)**

Projet personnel, non officiel : ni 42 ni 42 Lyon n'y sont associés.

## Ce que fait l'extension

- **Notifie avant l'échéance.** Par défaut 30 min avant, puis une relance toutes
  les 15 min, puis une alerte par minute dans les 5 dernières minutes. Si
  l'échéance passe quand même, une dernière notification le dit (« Logtime
  perdu »), une seule fois.
- **Affiche le temps restant sur son icône** (`3h`, `42m`), arrondi vers le bas :
  vert, orange une fois dans le préavis, rouge dans les 5 dernières minutes.
- **Suit ta session même sans onglet attendance ouvert**, tant que Firefox
  tourne et que tu y es connecté à attendance.
- **Voit un rebadge ou un badge out sans F5.** La page attendance ne se met pas
  à jour toute seule après un badge ; l'extension la redemande au serveur. Un
  rebadge est vu en 5 min environ, en 1 min à l'approche du préavis.
- **Ouvre attendance d'un clic** sur la notification (ou recharge l'onglet déjà
  ouvert).

Le popup (clic sur l'icône) montre le temps restant, l'heure d'échéance, l'heure
de début de la présence et les deux réglages.

## Ce qu'elle ne fait pas

- **Elle ne badge pas à ta place** et n'envoie rien à attendance : elle ne fait
  que lire la page (requêtes `GET`).
- **Firefox fermé ou machine en veille, aucune alerte.** Au réveil de la
  machine, si l'échéance est passée entre-temps, tu reçois la notification
  « Logtime perdu ».
- **Déconnecté d'attendance et sans onglet ouvert, elle est aveugle** : la
  relecture tombe sur la page de connexion 42 et rien ne change. Le popup ne le
  signale pas encore.
- **Un premier badge, sans onglet attendance ni session en cours, est repéré
  en 15 min environ**, pas immédiatement.
- **L'heure de début affichée (« depuis … ») est indicative** : elle peut être
  approximative juste après un rebadge et autour de minuit. Les alertes n'en
  dépendent pas, seulement de l'échéance.
- **Firefox uniquement** (115 ou plus récent), **campus de Lyon uniquement** :
  attendance est un outil de 42 Lyon qui n'existe pas ailleurs.

## Accès et données

Aucune donnée ne sort de ton navigateur : pas de serveur tiers, pas de
statistiques, pas de compte. Le seul domaine contacté est
`attendance.42lyon.fr`.

| Permission | Pourquoi |
|---|---|
| `notifications` | afficher les alertes |
| `storage` | garder en local tes réglages et la session en cours |
| `alarms` | se réveiller chaque minute, même sans onglet attendance |
| accès à `attendance.42lyon.fr` | lire la page, et la redemander au serveur |

Pas de permission `cookies` ni `tabs` : Firefox joint lui-même ta session 42 aux
requêtes vers attendance, l'extension ne lit aucun cookie.

**Ce qui est stocké** (`storage.local`, sur ta machine) : tes réglages, la
session en cours (heure de début, échéance, statut, nombre et heure des
notifications envoyées), l'heure du dernier échange avec un onglet et de la
dernière relecture, et la dernière erreur de notification s'il y en a eu une.

**Ce qui part sur le réseau** : des `GET` vers attendance avec ta session, pour
relire la page.

| Situation | Qui relit | Cadence |
|---|---|---|
| onglet attendance ouvert | l'onglet | toutes les 5 min |
| aucun onglet, session en cours | l'extension en arrière-plan | toutes les 5 min |
| échéance à moins de (préavis + 5 min) | l'un ou l'autre | chaque minute |
| aucun onglet, aucune session | l'extension en arrière-plan | toutes les 15 min |

La dernière ligne sert à repérer un premier badge sans que tu ouvres
attendance : environ 96 requêtes par jour vers le serveur du campus tant que
Firefox tourne. C'est un choix assumé, réglable dans le code
(`IDLE_REFRESH_MS`, `background.js`).

## Installation

1. Installe l'extension depuis
   [Firefox Add-ons](https://addons.mozilla.org/fr/firefox/addon/42-attendance-reminder/).
2. Ouvre `attendance.42lyon.fr` et connecte-toi. Reste connecté : c'est ta
   session 42 dans Firefox qui permet à l'extension de lire la page.
3. Clique sur l'icône de l'extension : le popup doit afficher ta session et le
   temps restant.

Si le popup affiche « L'extension n'a pas accès à attendance », clique sur
« Autoriser l'accès ». Ça arrive avec Firefox < 127 (qui n'accorde pas l'accès
au site à l'installation), si l'accès a été retiré dans `about:addons`, ou avec
un module chargé temporairement.

Les notifications passent par celles du système : si elles sont coupées pour
Firefox, rien ne s'affiche. Quand le système en refuse une, le popup l'indique.

## Configuration

Clique sur l'icône de l'extension.

- **Prévenir avant l'échéance** : préavis en minutes (défaut 30, de 1 min à
  3 h 59).
- **Relancer toutes les** : intervalle des rappels en minutes (défaut 15, de 1 à
  120).

Le préavis est borné à 1 min minimum : impossible de configurer une alerte qui
arrive trop tard.

Deux réglages de mise au point n'ont pas de champ dans le popup, pour ne pas
l'encombrer : ils se posent depuis la console du background (`about:debugging`
→ Inspecter).

```js
browser.storage.local.get('settings').then(({ settings }) =>
  browser.storage.local.set({ settings: { ...settings, debug: true } }));
```

- `debug` : trace chaque tick dans la console de la page attendance et du
  background.
- `testMode` : le préavis du popup se saisit en secondes et descend à 5 s, pour
  vérifier la chaîne de notification sans attendre des heures. Sous la minute,
  l'alerte part au tick du content script (15 s) : il faut un onglet attendance
  ouvert, l'alarme du background ne sonnant qu'une fois par minute.

Quand un onglet attendance est ouvert mais qu'aucun badge n'y est reconnu, le
popup le dit (« Page attendance ouverte, mais aucun badge reconnu ») : soit tu
n'es pas connecté, soit le format de la page a changé et la détection est à
revoir.

## Comment ça marche

Le domaine visé vit dans `ATTENDANCE_HOST` (`parser.js`), d'où découlent l'URL
du bouton « Ouvrir l'attendance » et le message du popup quand rien n'est
détecté.

- `content.js` observe la page attendance (tick toutes les 15 s, au retour sur
  l'onglet, et MutationObserver sur les rechargements ajax) et rapporte l'état
  de badge au background. Il ne parle au background que si l'état a changé, ou
  au plus une fois par tick : `detect()` parcourt le DOM trois fois, et la page
  rafraîchit son compte à rebours toute seule — sans ce filtre, chaque mutation
  réveillait la page background et écrivait dans `storage.local`.
- La page attendance ne se met pas à jour après un badge : seul son compte à
  rebours défile. `content.js` la redemande donc au serveur (toutes les 5 min,
  chaque minute à l'approche du préavis) et lit l'échéance dans la réponse,
  sans recharger l'onglet. Un rebadge ou un badge out est ainsi vu sans F5.
  Si la relecture échoue (réseau, session 42 expirée), ce que la page affiche
  continue de faire foi.
  La réponse brute du serveur donne ses lignes de présence en UTC (le
  navigateur les repasse en heure locale à l'affichage) : on n'y lit que
  l'échéance annoncée, la seule en heure locale. Tant qu'elle confirme la page,
  la page reste la source.
- Sans onglet attendance ouvert, c'est `background.js` qui redemande la page
  (`readServer`), au même rythme, dès qu'aucun onglet ne s'est manifesté depuis
  deux minutes. Firefox joint la session 42 à la requête de lui-même : la
  permission d'hôte suffit, aucun cookie n'est lu. Sans session en cours, la
  relecture tombe à une toutes les 15 min, juste de quoi repérer un premier
  badge sans jamais ouvrir attendance. Il faut rester connecté à attendance
  dans Firefox ; déconnecté, la relecture ne donne rien et rien ne change.
- `background.js` est seul à décider des notifications. Tout son état vit dans
  `storage.local` : en MV3 la page background est non-persistante, la mémoire est
  perdue à tout moment.
- Une alarme d'une minute prend le relais : même sans onglet attendance ouvert, le
  compteur continue et l'alerte part. Elle n'est (re)créée que si elle n'existe
  pas : `alarms.create` remplaçant l'alarme de même nom, la recréer à chaque
  réveil du background remettrait son compte à zéro et elle ne sonnerait jamais.
- Le temps restant s'affiche sur l'icône (`action.setBadgeText`), arrondi vers le
  bas pour ne jamais laisser croire qu'il reste plus de temps qu'en réalité.

### Détection

La page d'attendance affiche elle-même son échéance : c'est la source la plus
fiable, aucune déduction n'est nécessaire. Les lignes de présence ne servent
qu'à l'heure de début, et à déduire l'échéance quand la page ne l'annonce pas.

| Signal | Ce qu'on en tire |
|---|---|
| `session expires at 14:31` | échéance exacte — prime sur tout le reste |
| compte à rebours `03h 08m` | échéance = maintenant + reste, si la ligne ci-dessus manque |
| attribut `datetime` ISO | heure de badge, immunisée aux fuseaux |
| `On Site 10:31` | heure de badge, échéance déduite (+4 h) |
| ligne dont une heure colle à maintenant | c'est la ligne en cours, pas une archive |
| deux heures entièrement passées | session terminée → `off_site` |

Une ligne d'attendance se termine par sa durée (`On Site Unsaved 10:31 11:22
00:51`) : ce `00:51` se lit comme une heure, d'où la règle « une heure proche de
maintenant » plutôt que « la dernière heure de la ligne ».

Sont gérés : `On Site`, `On Site Unsaved`, `On site (unsaved)`, l'échéance en
anglais ou en français (`la session expire à`), séparateurs `:` ou `h`, heure de
la veille (badge après minuit), et le badge out (reset du timer).

Une échéance annoncée à plus de 4 h dans le futur est lue comme déjà passée :
c'est une page restée ouverte, pas l'échéance du lendemain.

Si aucun marqueur n'est trouvé, l'état passe à `unknown` et la session **n'est pas**
effacée — le DOM de la page peut changer, on préfère garder le timer que le perdre.

### Anti-spam

Une seule notification au franchissement du préavis, puis une relance toutes les
15 min (configurable), et une alerte prioritaire dans les 5 dernières minutes
(au plus une par minute). Passé l'échéance, une dernière alerte part — au réveil
après une veille machine, aucune n'a pu être envoyée à temps, et le silence ne
dirait pas si le logtime est perdu ou s'il n'y avait rien à signaler. L'état de
notification est persisté : recharger la page ou l'extension ne re-notifie pas.

Une échéance déduite d'un compte à rebours (`03h08m`) n'a que la minute pour
granularité : elle bouge de quelques secondes d'une lecture à l'autre. Seul un
écart de plus de deux minutes compte comme un rebadge, sinon le cycle d'alerte
repartirait de zéro à chaque tick.

Si le système refuse la notification, l'erreur est stockée et affichée dans le
popup : sans ça, l'extension a l'air de tourner et n'alerte jamais.

Rebadger repousse l'échéance : le cycle d'alerte repart à zéro, mais la présence
en cours et son heure de début sont conservées.

Une session dont l'échéance est passée est effacée, sans qu'aucun onglet n'ait à
être ouvert : l'alarme s'en charge. C'est nécessaire, sinon elle traîne dans
`storage.local` et le badge du lendemain se fusionnerait avec elle, affichant
l'heure de début de la veille. Symétriquement, une échéance déjà passée à la
découverte n'ouvre pas de session : il n'y a plus rien à surveiller, et l'ouvrir
pour la purger aussitôt ferait recréer-notifier-effacer à chaque tick.
(`isSessionOver` sait aussi conclure sans échéance, à partir de `lastSeenMs` :
plus que défensif aujourd'hui, pour de l'état écrit par une version antérieure.)

## Développement

```sh
npm test    # parser.js, background.js, content.js, et manifest/package.json en phase
npm run lint    # web-ext lint, avant toute soumission AMO (exige Node >= 20)
npm run build   # web-ext-artifacts/42-attendance-reminder.zip
```

Pour tester en local, charge le dossier via `about:debugging` → « Charger un
module temporaire ».

`version` est dupliqué entre `manifest.json` et `package.json` : `version:check`
casse le test et le build si les deux divergent.

Les tests et le build tournent sur n'importe quel Node ; seul `lint` demande un
Node ≥ 20, parce que web-ext l'exige. Le script le vérifie et le dit, plutôt que
de laisser web-ext échouer sur un `SyntaxError` incompréhensible.

`test/background.test.js` charge `parser.js` puis `background.js` dans un `vm`
avec un faux `browser` (`test/fake-api.js`), comme Firefox charge les deux
scripts dans la même page. C'est là que se testent les scénarios qui n'ont
aucun DOM : onglet fermé, réveil après veille, badge du lendemain, rebadge,
relecture du serveur sans onglet.
`test/content.test.js` fait de même pour `content.js`, avec un faux `fetch` et
une horloge avancée à la main : rebadge et badge out vus sans rechargement.

Le zip est fabriqué avec `zip(1)` et liste explicitement les fichiers
empaquetés : ni les tests ni aucun fichier parasite ne partent sur AMO. Ajouter
un fichier au paquet demande de compléter la liste dans `package.json`.

Les icônes empaquetées sont les `.png` : AMO veut du bitmap pour la fiche du
module. Les `.svg` restent la source ; après les avoir modifiées, régénère :

```sh
python3 -c "import cairosvg
for s in (16, 48, 96, 128):
    cairosvg.svg2png(url=f'icon-{s}.svg', write_to=f'icon-{s}.png',
                     output_width=s, output_height=s)"
```

## Publier

1. Incrémente `version` dans `manifest.json` **et** `package.json` — AMO refuse
   une version déjà envoyée, définitivement.
2. `npm test && npm run lint && npm run build`
3. [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) →
   le module → envoyer une nouvelle version, avec le zip.
4. Mets à jour la description de la fiche (anglais et français) si le
   comportement a changé.

## Fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | config MV3 |
| `parser.js` | logique pure, partagée par tous les scripts et les tests |
| `test/` | tests de `parser.js`, `background.js` et `content.js`, non empaquetés |
| `content.js` | observation du DOM attendance |
| `background.js` | état des sessions, notifications |
| `popup.html` / `popup.js` | UI (thème clair/sombre auto) |
| `icon-*.png` | icônes 16/48/96/128 empaquetées (chronomètre + pastille d'alerte) |
| `icon-*.svg` | sources vectorielles des icônes, non empaquetées |

## Notes

- Vanilla JS, aucune dépendance.
- Fuseaux horaires : les heures affichées sont interprétées dans le fuseau du
  navigateur. Si l'écart donne un temps négatif ou > 24 h, la valeur est rejetée
  plutôt que d'afficher n'importe quoi. Un timestamp ISO, quand la page en
  expose un, est préféré et le problème ne se pose pas.

## Bugs / améliorations

Ouvre une [issue](https://github.com/Primoux/42-attendance-reminder/issues),
fais une PR, ou passe par Discord.

## Licence

MIT — voir [LICENSE](LICENSE).
