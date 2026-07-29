# 42 Attendance Reminder

Extension Firefox qui te prévient **avant** que ta session d'attendance expire et
que tu perdes ton logtime.

Cible `attendance.42lyon.fr` (et `*.intra.42.fr` en secours).

## Installation

Depuis [Firefox Add-ons](https://addons.mozilla.org/fr/firefox/) — cherche
« 42 Attendance Reminder », ou installe-la depuis la page du module.

## Comment ça marche

- `content.js` observe la page attendance (tick toutes les 15 s + MutationObserver sur
  les rechargements ajax) et rapporte l'état de badge au background.
- `background.js` est seul à décider des notifications. Tout son état vit dans
  `storage.local` : en MV3 la page background est non-persistante, la mémoire est
  perdue à tout moment.
- Une alarme d'une minute prend le relais : même sans onglet attendance ouvert, le
  compteur continue et l'alerte part.

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
ou `h`, heure de la veille (badge après minuit), et le badge out (reset du timer
et rangement de la session dans l'historique).

Si aucun marqueur n'est trouvé, l'état passe à `unknown` et la session **n'est pas**
effacée — le DOM de la page peut changer, on préfère garder le timer que le perdre.

### Anti-spam

Une seule notification au franchissement du préavis, puis une relance toutes les
15 min (configurable), et une alerte prioritaire dans les 5 dernières minutes
(au plus une par minute). L'état de notification est persisté : recharger la
page ou l'extension ne re-notifie pas.

Rebadger repousse l'échéance : le cycle d'alerte repart à zéro, mais la présence
en cours et son heure de début sont conservées.

## Configuration

Clique sur l'icône de l'extension.

- **Prévenir avant l'échéance** : préavis en minutes (défaut 30).
- **Relancer toutes les** : intervalle des rappels.
- **Mode test** : débloque la saisie du préavis en secondes (min 5 s) pour
  vérifier que la chaîne complète marche sans attendre des heures.
- **Logs console détaillés** : trace chaque tick dans la console de la page
  attendance et dans celle du background.

Le préavis est borné à 1 min minimum : impossible de configurer une alerte qui
arrive trop tard.

## Historique

Les 50 dernières sessions restent enregistrées dans `storage.local` (durée,
alerte déclenchée) mais ne sont plus affichées. Le message `resetStats` du
background les efface.

## Développement

```sh
npm install -g web-ext
npm run dev      # Firefox dédié, rechargement auto à chaque sauvegarde
npm run build    # génère le .zip à envoyer sur addons.mozilla.org
npm test
```

- `test/parser.test.js` : détection DOM et logique de notification, sur un faux
  DOM minimal (`test/fakedom.js`).
- `test/background.test.js` : charge `parser.js` + `background.js` dans un faux
  `browser` (promesses, comme Firefox) et exerce la machine à états — création
  de session, anti-spam, badge out, rebadge, `getStatus`, `resetStats`.

Micro-runner maison (`test/tiny.js`), zéro dépendance, marche depuis Node 12.

## Fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | config MV3 |
| `parser.js` | logique pure, partagée par tous les scripts et les tests |
| `content.js` | observation du DOM attendance |
| `background.js` | état des sessions, notifications, historique |
| `popup.html` / `popup.js` | UI (thème clair/sombre auto) |
| `icon-*.svg` | icônes 16/48/96/128 (chronomètre + pastille d'alerte) |
| `test/` | tests |

## Notes

- Uniquement sur `attendance.42lyon.fr` et `*.intra.42.fr`, aucune donnée ne sort
  du navigateur. Autre campus : ajoute son domaine dans `manifest.json`
  (`host_permissions` **et** `content_scripts[0].matches`).
- Vanilla JS, aucune dépendance.
- Fuseaux horaires : les heures affichées sont interprétées dans le fuseau du
  navigateur. Si l'écart donne un temps négatif ou > 24 h, la valeur est rejetée
  plutôt que d'afficher n'importe quoi. Un timestamp ISO, quand la page en
  expose un, est préféré et le problème ne se pose pas.

## Bugs/Améliorations?

Partage sur Discord ou fais une PR.
