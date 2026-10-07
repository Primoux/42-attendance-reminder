# 42 Attendance Reminder

Extension Firefox qui te prévient **avant** que ta session d'attendance expire et
que tu perdes ton logtime.

Cible `attendance.42lyon.fr`. attendance est un outil de 42 Lyon pour le campus
de Lyon : il n'existe pas ailleurs, l'extension n'a donc qu'un seul domaine à
viser. Il vit dans `ATTENDANCE_HOST` (`parser.js`), d'où découlent l'URL du
bouton « Ouvrir l'attendance » et le message du popup quand rien n'est détecté.

## Installation

Depuis [Firefox Add-ons](https://addons.mozilla.org/fr/firefox/) — cherche
« 42 Attendance Reminder », ou installe-la depuis la page du module.

## Comment ça marche

- `content.js` observe la page attendance (tick toutes les 15 s + MutationObserver sur
  les rechargements ajax) et rapporte l'état de badge au background. Il ne parle
  au background que si l'état a changé, ou au plus une fois par tick : `detect()`
  parcourt le DOM trois fois, et la page rafraîchit son compte à rebours toute
  seule — sans ce filtre, chaque mutation réveillait la page background et
  écrivait dans `storage.local`.
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
fiable, aucune déduction n'est nécessaire.

| Signal | Priorité |
|---|---|
| `LA SESSION EXPIRE À 14:31` | la plus haute — échéance exacte |
| compte à rebours `03h08m` | échéance = maintenant + reste |
| attribut `datetime` ISO | heure de badge, immunisé aux fuseaux |
| `On Site 10:31` | heure de badge, échéance déduite (+4h) |
| ligne dont une heure colle à maintenant | c'est la ligne en cours, pas une archive |
| deux heures entièrement passées | session terminée → `off_site` |

Une ligne d'attendance se termine par sa durée (`On Site Unsaved 10:31 → 11:22
00:51`) : ce `00:51` se lit comme une heure, d'où la règle « une heure proche de
maintenant » plutôt que « la dernière heure de la ligne ».

Sont gérés : `On Site`, `On Site Unsaved`, `On site (unsaved)`, séparateurs `:`
ou `h`, heure de la veille (badge après minuit), et le badge out (reset du timer).

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

## Configuration

Clique sur l'icône de l'extension.

- **Prévenir avant l'échéance** : préavis en minutes (défaut 30).
- **Relancer toutes les** : intervalle des rappels.

Le préavis est borné à 1 min minimum : impossible de configurer une alerte qui
arrive trop tard.

La section « Avancé » du popup porte deux réglages de mise au point :

- **Journal de debug** : trace chaque tick dans la console de la page
  attendance et du background (`about:debugging` → Inspecter).
- **Mode test** : le préavis se saisit en secondes et descend à 5 s, pour
  vérifier la chaîne de notification sans attendre des heures. Sous la minute,
  l'alerte part au tick du content script (15 s) : il faut un onglet attendance
  ouvert, l'alarme du background ne sonnant qu'une fois par minute.

Si Firefox n'a pas accordé l'accès à `attendance.42lyon.fr` (module chargé
temporairement, Firefox < 127, ou accès retiré dans `about:addons`), rien ne
peut être surveillé : le popup l'affiche, avec un bouton « Autoriser l'accès ».

Quand un onglet attendance est ouvert mais qu'aucun badge n'y est reconnu, le
popup le dit (« Page attendance ouverte, mais aucun badge reconnu ») : soit tu
n'es pas connecté, soit le format de la page a changé et la détection est à
revoir.

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
   *Submit a New Add-on* → **On your own** (auto-distribution, validation
   automatique) ou *On this site* (revue humaine, publication publique).
4. Envoie le zip. Le `.xpi` signé est proposé au téléchargement.
5. Tes potes ouvrent le `.xpi` dans Firefox : l'installation est permanente.

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

- Uniquement sur `attendance.42lyon.fr`, aucune donnée ne sort
  du navigateur. Autre campus : ajoute son domaine dans `manifest.json`
  (`host_permissions` **et** `content_scripts[0].matches`).
- Vanilla JS, aucune dépendance.
- Fuseaux horaires : les heures affichées sont interprétées dans le fuseau du
  navigateur. Si l'écart donne un temps négatif ou > 24 h, la valeur est rejetée
  plutôt que d'afficher n'importe quoi. Un timestamp ISO, quand la page en
  expose un, est préféré et le problème ne se pose pas.

## Bugs/Améliorations?

Partage sur Discord ou fais une PR.

## Licence

MIT — voir [LICENSE](LICENSE).
