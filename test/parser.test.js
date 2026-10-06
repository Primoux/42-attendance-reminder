/*
 * Tests de parser.js - la partie la plus fragile du projet : des regex sur un
 * DOM qu'on ne contrôle pas. `node test/parser.test.js` ou `npm test`.
 *
 * Pas de framework : assert natif, pour rester à zéro dépendance.
 */

const assert = require('assert');
const { el, dom } = require('./fake-dom');
const P = require('../parser');

// ---------------------------------------------------------------- harnais

let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) { currentGroup = name; }

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name: `${currentGroup} > ${name}`, err });
  }
}

// ------------------------------------------------------------------ temps
// Toutes les heures sont construites en heure locale, comme resolveClockTime :
// les tests restent valides quel que soit le fuseau de la machine.

const at = (h, m, s = 0) => new Date(2026, 7, 11, h, m, s, 0).getTime();
const atOffsetDay = (days, h, m) => new Date(2026, 7, 11 + days, h, m, 0, 0).getTime();
const NOW = at(12, 0);

// ----------------------------------------------------------- la constante

group('SESSION_MAX_SECONDS');

test('vaut 4h, en dur', () => {
  // Épinglé volontairement à un littéral : c'est la règle d'attendance
  // (logtime perdu à 3h59), et tout le reste des tests s'exprime en fonction
  // de cette constante - sans ce test, la changer ne casserait rien.
  assert.strictEqual(P.SESSION_MAX_SECONDS, 14400);
});

test('une session type dure bien 4h', () => {
  const r = P.detect(dom('On Site 10:31'), NOW);
  assert.strictEqual(P.formatClock(r.expiryMs), '14:31');
});

// ------------------------------------------------------------- normalize

group('normalize');

test('réduit les espaces et rogne les bords', () => {
  assert.strictEqual(P.normalize('  On   Site\n 10:31  '), 'On Site 10:31');
});

test('tolère null et undefined', () => {
  assert.strictEqual(P.normalize(null), '');
  assert.strictEqual(P.normalize(undefined), '');
});

// ------------------------------------------------------------- findTimes

group('findTimes');

test('trouve une heure isolée', () => {
  const times = P.findTimes('On Site 10:31');
  assert.strictEqual(times.length, 1);
  assert.deepStrictEqual(
    { h: times[0].hours, m: times[0].minutes, s: times[0].seconds },
    { h: 10, m: 31, s: 0 }
  );
});

test('trouve les deux bornes d\'un intervalle', () => {
  const times = P.findTimes('10:31 - 14:00');
  assert.strictEqual(times.length, 2);
  assert.strictEqual(times[0].hours, 10);
  assert.strictEqual(times[1].hours, 14);
});

test('accepte la notation 10h31', () => {
  const times = P.findTimes('badgé à 10h31');
  assert.strictEqual(times.length, 1);
  assert.strictEqual(times[0].minutes, 31);
});

test('lit les secondes quand elles sont là', () => {
  assert.strictEqual(P.findTimes('10:31:05')[0].seconds, 5);
});

test('rejette les heures impossibles', () => {
  assert.strictEqual(P.findTimes('42:00').length, 0);
  assert.strictEqual(P.findTimes('25:00').length, 0);
  assert.strictEqual(P.findTimes('10:75').length, 0);
});

test('ignore les numéros de version', () => {
  assert.strictEqual(P.findTimes('version 1.2.3').length, 0);
});

// ------------------------------------------------------- resolveClockTime

group('resolveClockTime');

const t = (h, m) => ({ hours: h, minutes: m, seconds: 0 });

test('une heure passée est aujourd\'hui', () => {
  assert.strictEqual(P.resolveClockTime(t(10, 31), NOW), at(10, 31));
});

test('une heure future appartient à hier (sens passé)', () => {
  assert.strictEqual(P.resolveClockTime(t(23, 0), NOW), atOffsetDay(-1, 23, 0));
});

test('une échéance future est aujourd\'hui (sens futur)', () => {
  assert.strictEqual(P.resolveClockTime(t(14, 31), NOW, 'future'), at(14, 31));
});

test('une échéance passée appartient à demain (sens futur)', () => {
  assert.strictEqual(P.resolveClockTime(t(9, 0), NOW, 'future'), atOffsetDay(1, 9, 0));
});

test('tolère 5 min de décalage d\'horloge', () => {
  // 12:04 alors qu'il est 12:00 : c'est bien aujourd'hui, pas hier
  assert.strictEqual(P.resolveClockTime(t(12, 4), NOW), at(12, 4));
});

test('null en entrée donne null', () => {
  assert.strictEqual(P.resolveClockTime(null, NOW), null);
});

// -------------------------------------------------------- parseIso / attrs

group('parseIso / readIsoAttr');

test('lit un timestamp ISO', () => {
  assert.strictEqual(P.parseIso('2026-08-11T10:31:00'), new Date('2026-08-11T10:31:00').getTime());
});

test('refuse ce qui n\'est pas de l\'ISO', () => {
  assert.strictEqual(P.parseIso('10:31'), null);
  assert.strictEqual(P.parseIso('n\'importe quoi'), null);
  assert.strictEqual(P.parseIso(null), null);
});

test('lit datetime, data-begin-at ou title', () => {
  const expected = new Date('2026-08-11T10:31:00').getTime();
  assert.strictEqual(P.readIsoAttr(el({ attrs: { datetime: '2026-08-11T10:31:00' } })), expected);
  assert.strictEqual(P.readIsoAttr(el({ attrs: { 'data-begin-at': '2026-08-11T10:31:00' } })), expected);
  assert.strictEqual(P.readIsoAttr(el({ attrs: { title: '2026-08-11T10:31:00' } })), expected);
});

test('descend chercher un enfant [datetime]', () => {
  const parent = el({ children: [el({ attrs: { datetime: '2026-08-11T10:31:00' } })] });
  assert.strictEqual(P.readIsoAttr(parent), new Date('2026-08-11T10:31:00').getTime());
});

test('rend null sans attribut exploitable', () => {
  assert.strictEqual(P.readIsoAttr(el('On Site')), null);
  assert.strictEqual(P.readIsoAttr(null), null);
});

// ------------------------------------------------------ collectCandidates

group('collectCandidates');

test('ne retient que les éléments qui parlent de présence', () => {
  const root = dom('On Site 10:31', 'Menu principal', 'Off Site');
  const found = P.collectCandidates(root).map((c) => c.text);
  assert.deepStrictEqual(found, ['On Site 10:31', 'Off Site']);
});

test('écarte les gros conteneurs', () => {
  // le parent contient le texte de l'enfant : sans la limite de longueur, il
  // matcherait aussi et ramènerait toutes les heures de la page
  const root = dom(el({
    text: 'x'.repeat(500),
    children: [el('On Site 10:31')]
  }));
  const found = P.collectCandidates(root).map((c) => c.text);
  assert.deepStrictEqual(found, ['On Site 10:31']);
});

test('remonte l\'ISO avec le candidat', () => {
  const root = dom(el({ text: 'On Site', attrs: { datetime: '2026-08-11T10:31:00' } }));
  assert.strictEqual(P.collectCandidates(root)[0].iso, new Date('2026-08-11T10:31:00').getTime());
});

// --------------------------------------------------------------- analyze

group('analyze');

const analyzeDom = (...specs) => P.analyze(P.collectCandidates(dom(...specs)), NOW);

test('sans candidat : unknown', () => {
  const r = analyzeDom('Bienvenue');
  assert.strictEqual(r.status, P.STATUS.UNKNOWN);
  assert.strictEqual(r.startMs, null);
});

test('off site seul : off_site', () => {
  assert.strictEqual(analyzeDom('Off Site').status, P.STATUS.OFF_SITE);
});

test('on site avec heure : startMs et source clock', () => {
  const r = analyzeDom('On Site 10:31');
  assert.strictEqual(r.status, P.STATUS.ON_SITE);
  assert.strictEqual(r.startMs, at(10, 31));
  assert.strictEqual(r.source, 'clock');
});

test('détecte le unsaved sous ses différentes formes', () => {
  assert.strictEqual(analyzeDom('On Site Unsaved 10:31').status, P.STATUS.ON_SITE_UNSAVED);
  assert.strictEqual(analyzeDom('ON-SITE - UNSAVED 10:31').status, P.STATUS.ON_SITE_UNSAVED);
  assert.strictEqual(analyzeDom('On site (unsaved) 10:31').status, P.STATUS.ON_SITE_UNSAVED);
});

test('l\'ISO prime sur l\'heure murale', () => {
  const r = analyzeDom(el({ text: 'On Site 10:31', attrs: { datetime: '2026-08-11T09:15:00' } }));
  assert.strictEqual(r.source, 'iso');
  assert.strictEqual(r.startMs, new Date('2026-08-11T09:15:00').getTime());
});

test('on site sans heure : badgé mais début inconnu', () => {
  const r = analyzeDom('On Site');
  assert.strictEqual(r.status, P.STATUS.ON_SITE);
  assert.strictEqual(r.startMs, null);
  assert.strictEqual(r.source, 'no-time');
});

test('intervalle entièrement passé : session terminée', () => {
  const r = analyzeDom('On Site 09:00 - 10:00');
  assert.strictEqual(r.status, P.STATUS.OFF_SITE);
  assert.strictEqual(r.source, 'closed-range');
});

test('intervalle dont la borne suit l\'horloge : session en cours', () => {
  const r = analyzeDom('On Site 11:58 - 12:00');
  assert.strictEqual(r.status, P.STATUS.ON_SITE);
  assert.strictEqual(r.source, 'live-range');
  assert.strictEqual(r.startMs, at(11, 58));
});

test('une heure dans le futur proche est écartée', () => {
  const r = analyzeDom('On Site 12:05');
  assert.strictEqual(r.status, P.STATUS.ON_SITE);
  assert.strictEqual(r.startMs, null);
  assert.strictEqual(r.source, 'out-of-range');
});

test('la ligne en cours l\'emporte sur les archives', () => {
  const r = analyzeDom('On Site 08:00 - 09:00', 'On Site 11:59');
  assert.strictEqual(r.startMs, at(11, 59));
});

// ---------------------------------------------------------- detectExpiry

group('detectExpiry');

test('lit l\'échéance annoncée par la page', () => {
  const r = P.detectExpiry(dom('LA SESSION EXPIRE À 14:31'), NOW);
  assert.strictEqual(r.expiryMs, at(14, 31));
  assert.strictEqual(r.source, 'expiry');
});

test('lit le compte à rebours', () => {
  const r = P.detectExpiry(dom('03h08m'), NOW);
  assert.strictEqual(r.expiryMs, NOW + (3 * 3600 + 8 * 60) * 1000);
  assert.strictEqual(r.source, 'countdown');
});

test('l\'échéance absolue prime sur le compte à rebours', () => {
  assert.strictEqual(P.detectExpiry(dom('03h08m', 'session expire à 14:31'), NOW).source, 'expiry');
});

test('rend null quand la page ne dit rien', () => {
  assert.strictEqual(P.detectExpiry(dom('On Site 10:31'), NOW), null);
});

// ---------------------------------------------------------------- detect

group('detect');

test('sans échéance affichée : déduit expiry = début + 4h', () => {
  const r = P.detect(dom('On Site 10:31'), NOW);
  assert.strictEqual(r.startMs, at(10, 31));
  assert.strictEqual(r.expiryMs, at(10, 31) + P.SESSION_MAX_SECONDS * 1000);
});

test('avec échéance affichée : déduit le début à rebours', () => {
  const r = P.detect(dom('On Site', 'LA SESSION EXPIRE À 14:31'), NOW);
  assert.strictEqual(r.expiryMs, at(14, 31));
  assert.strictEqual(r.startMs, at(14, 31) - P.SESSION_MAX_SECONDS * 1000);
  assert.strictEqual(r.source, 'expiry');
});

test('garde l\'heure de badge réelle quand le DOM la donne', () => {
  const r = P.detect(dom('On Site 10:31', 'LA SESSION EXPIRE À 14:31'), NOW);
  assert.strictEqual(r.startMs, at(10, 31));
  assert.strictEqual(r.expiryMs, at(14, 31));
  assert.strictEqual(r.source, 'clock+expiry');
});

test('une échéance sans marqueur on site suppose quand même la présence', () => {
  const r = P.detect(dom('LA SESSION EXPIRE À 14:31'), NOW);
  assert.strictEqual(r.status, P.STATUS.ON_SITE);
});

test('page muette : unknown et pas d\'échéance', () => {
  const r = P.detect(dom('Bienvenue'), NOW);
  assert.strictEqual(r.status, P.STATUS.UNKNOWN);
  assert.strictEqual(r.expiryMs, null);
});

// ---------------------------------------------------- isOnSite / expiry

group('isOnSite / sessionExpiry');

test('isOnSite couvre le cas unsaved', () => {
  assert.strictEqual(P.isOnSite(P.STATUS.ON_SITE), true);
  assert.strictEqual(P.isOnSite(P.STATUS.ON_SITE_UNSAVED), true);
  assert.strictEqual(P.isOnSite(P.STATUS.OFF_SITE), false);
  assert.strictEqual(P.isOnSite(P.STATUS.UNKNOWN), false);
});

test('sessionExpiry préfère l\'échéance connue', () => {
  assert.strictEqual(P.sessionExpiry({ startMs: at(10, 31), expiryMs: at(14, 0) }), at(14, 0));
});

test('sessionExpiry retombe sur début + 4h', () => {
  assert.strictEqual(
    P.sessionExpiry({ startMs: at(10, 31) }),
    at(10, 31) + P.SESSION_MAX_SECONDS * 1000
  );
});

test('sessionExpiry rend null sans rien d\'exploitable', () => {
  assert.strictEqual(P.sessionExpiry(null), null);
  assert.strictEqual(P.sessionExpiry({}), null);
});

// ------------------------------------------------------------ isNewDeadline

group('isNewDeadline');

test('un rebadge repousse l\'échéance de plusieurs minutes', () => {
  assert.strictEqual(P.isNewDeadline(at(14, 31), at(16, 0)), true);
});

test('quelques secondes d\'écart, c\'est le même instant relu', () => {
  assert.strictEqual(P.isNewDeadline(at(14, 31), at(14, 31, 12)), false);
  assert.strictEqual(P.isNewDeadline(at(14, 31), at(14, 32, 30)), false);
});

test('une échéance qui recule franchement compte aussi', () => {
  assert.strictEqual(P.isNewDeadline(at(16, 0), at(14, 31)), true);
});

test('pas d\'échéance connue : la première est une nouveauté', () => {
  assert.strictEqual(P.isNewDeadline(null, at(14, 31)), true);
});

test('rien n\'arrive : rien ne change', () => {
  assert.strictEqual(P.isNewDeadline(at(14, 31), null), false);
});

// --------------------------------------------------- decideNotification

group('decideNotification');

const SETTINGS = { warnBeforeSeconds: 1800, repeatSeconds: 900 };
// session dont l'échéance tombe dans `remaining` secondes
const session = (remaining, extra = {}) =>
  Object.assign({ startMs: NOW - 3600 * 1000, expiryMs: NOW + remaining * 1000 }, extra);

test('pas d\'échéance : on se tait', () => {
  assert.strictEqual(P.decideNotification({}, SETTINGS, NOW).notify, false);
});

test('encore loin du seuil : on se tait', () => {
  assert.strictEqual(P.decideNotification(session(3600), SETTINGS, NOW).notify, false);
});

test('premier passage sous le seuil : threshold', () => {
  const d = P.decideNotification(session(1500, { notifiedCount: 0 }), SETTINGS, NOW);
  assert.strictEqual(d.notify, true);
  assert.strictEqual(d.kind, 'threshold');
  assert.strictEqual(d.remainingSeconds, 1500);
});

test('déjà notifié récemment : on se tait', () => {
  const s = session(1500, { notifiedCount: 1, lastNotifiedMs: NOW - 300 * 1000 });
  assert.strictEqual(P.decideNotification(s, SETTINGS, NOW).notify, false);
});

test('relance passé repeatSeconds', () => {
  const s = session(1500, { notifiedCount: 1, lastNotifiedMs: NOW - 900 * 1000 });
  assert.strictEqual(P.decideNotification(s, SETTINGS, NOW).kind, 'repeat');
});

test('dernière ligne droite : logtime_lost_soon', () => {
  const s = session(200, { notifiedCount: 3, lastNotifiedMs: NOW - 70 * 1000 });
  assert.strictEqual(P.decideNotification(s, SETTINGS, NOW).kind, 'logtime_lost_soon');
});

test('dernière ligne droite : au plus une par minute', () => {
  const s = session(200, { notifiedCount: 3, lastNotifiedMs: NOW - 30 * 1000 });
  assert.strictEqual(P.decideNotification(s, SETTINGS, NOW).notify, false);
});

test('échéance dépassée : une dernière alerte', () => {
  const s = session(-10, { notifiedCount: 3, lastNotifiedMs: 0 });
  const d = P.decideNotification(s, SETTINGS, NOW);
  assert.strictEqual(d.notify, true);
  assert.strictEqual(d.kind, 'expired');
});

test('échéance dépassée, dernière alerte déjà envoyée : silence', () => {
  const s = session(-10, { notifiedCount: 4, lastNotifiedMs: NOW, expiredNotified: true });
  assert.strictEqual(P.decideNotification(s, SETTINGS, NOW).notify, false);
});

test('échéance dépassée depuis longtemps : toujours une seule alerte', () => {
  const s = session(-7200, { notifiedCount: 4, expiredNotified: true });
  assert.strictEqual(P.decideNotification(s, SETTINGS, NOW).notify, false);
});

test('remonte le temps écoulé sur place', () => {
  assert.strictEqual(P.decideNotification(session(1500), SETTINGS, NOW).elapsedSeconds, 3600);
});

// ---------------------------------------------- warnBeforeUnitSeconds

group('warnBeforeUnitSeconds');

test('le préavis se saisit en minutes, en secondes en mode test', () => {
  assert.strictEqual(P.warnBeforeUnitSeconds(false), 60);
  assert.strictEqual(P.warnBeforeUnitSeconds(undefined), 60);
  assert.strictEqual(P.warnBeforeUnitSeconds(true), 1);
});

// ---------------------------------------------------- clampWarnBefore

group('clampWarnBefore');

test('plancher à 1 min hors mode test', () => {
  assert.strictEqual(P.clampWarnBefore(30, false), 60);
});

test('plafond sous la durée de session', () => {
  assert.strictEqual(P.clampWarnBefore(99999, false), P.SESSION_MAX_SECONDS - 60);
});

test('le mode test descend à 5 s', () => {
  assert.strictEqual(P.clampWarnBefore(30, true), 30);
  assert.strictEqual(P.clampWarnBefore(2, true), 5);
});

test('une saisie absurde retombe sur le défaut', () => {
  assert.strictEqual(P.clampWarnBefore('abc', false), P.DEFAULT_SETTINGS.warnBeforeSeconds);
  assert.strictEqual(P.clampWarnBefore(undefined, false), P.DEFAULT_SETTINGS.warnBeforeSeconds);
});

// ----------------------------------------------------------- fin de session

group('isSessionOver');

test('une session dont l\'échéance est à venir court toujours', () => {
  assert.strictEqual(P.isSessionOver({ expiryMs: at(14, 31) }, NOW), false);
});

test('une session dont l\'échéance est passée est finie', () => {
  assert.strictEqual(P.isSessionOver({ expiryMs: at(11, 59) }, NOW), true);
});

test('sans expiryMs, l\'échéance se déduit du début (+4h)', () => {
  assert.strictEqual(P.isSessionOver({ startMs: at(9, 0) }, NOW), false);
  assert.strictEqual(P.isSessionOver({ startMs: at(7, 30) }, NOW), true);
});

test('sans échéance, une session confirmée récemment est gardée', () => {
  assert.strictEqual(P.isSessionOver({ lastSeenMs: at(11, 0) }, NOW), false);
});

test('sans échéance ni nouvelle depuis plus d\'une session, elle est finie', () => {
  assert.strictEqual(P.isSessionOver({ lastSeenMs: atOffsetDay(-1, 22, 0) }, NOW), true);
});

test('une session sans aucun repère n\'est jamais déclarée finie', () => {
  assert.strictEqual(P.isSessionOver({ status: P.STATUS.ON_SITE }, NOW), false);
});

test('pas de session, rien à terminer', () => {
  assert.strictEqual(P.isSessionOver(null, NOW), false);
});

// ------------------------------------------------------------- formatage

group('formatDuration / formatClock');

test('formate les heures, minutes et secondes', () => {
  assert.strictEqual(P.formatDuration(3 * 3600 + 8 * 60), '3h08m');
  assert.strictEqual(P.formatDuration(5 * 60 + 3), '5m03s');
  assert.strictEqual(P.formatDuration(42), '42s');
});

test('jamais de durée négative', () => {
  assert.strictEqual(P.formatDuration(-5), '0s');
});

test('formate l\'heure sur deux chiffres', () => {
  assert.strictEqual(P.formatClock(at(9, 5)), '09:05');
  assert.strictEqual(P.formatClock(at(14, 31)), '14:31');
});

// ------------------------------------------------------------------ badge

group('badgeText / badgeColor');

test('les heures priment sur les minutes', () => {
  assert.strictEqual(P.badgeText(3 * 3600 + 50 * 60), '3h');
  assert.strictEqual(P.badgeText(3600), '1h');
});

test('arrondi vers le bas : jamais plus de temps qu\'il n\'en reste', () => {
  assert.strictEqual(P.badgeText(3599), '59m');
  assert.strictEqual(P.badgeText(21 * 60 + 59), '21m');
});

test('sous la minute, il reste quand même quelque chose', () => {
  assert.strictEqual(P.badgeText(30), '1m');
});

test('rien à afficher sans temps restant', () => {
  assert.strictEqual(P.badgeText(0), '');
  assert.strictEqual(P.badgeText(-10), '');
  assert.strictEqual(P.badgeText(null), '');
});

test('la couleur suit les seuils du popup', () => {
  assert.strictEqual(P.badgeColor(3600, 1800), '#1f8a4c');
  assert.strictEqual(P.badgeColor(1200, 1800), '#c9500f');
  assert.strictEqual(P.badgeColor(120, 1800), '#d7263d');
});

// ---------------------------------------------------------------- bilan

if (failures.length === 0) {
  console.log(`✅ ${passed} tests passés`);
} else {
  console.log(`❌ ${failures.length} échec(s) sur ${passed + failures.length} tests\n`);
  for (const f of failures) {
    console.log(`--- ${f.name}`);
    console.log(`    ${f.err.message.split('\n').join('\n    ')}\n`);
  }
  process.exit(1);
}
