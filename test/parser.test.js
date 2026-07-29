const { test } = require('./tiny.js');
const assert = require('assert');
const P = require('../parser.js');
const { h, makeDocument } = require('./fakedom.js');

// Référence temporelle fixe pour tous les tests : 2026-07-29 14:00 heure locale
const NOW = new Date(2026, 6, 29, 14, 0, 0, 0).getTime();
const at = (hh, mm, ss = 0) => new Date(2026, 6, 29, hh, mm, ss, 0).getTime();

test('findTimes trouve les heures et ignore le bruit', () => {
  assert.deepStrictEqual(P.findTimes('On Site 10:31').map((t) => t.raw), ['10:31']);
  assert.deepStrictEqual(P.findTimes('10:31 - 14:05').map((t) => t.raw), ['10:31', '14:05']);
  assert.deepStrictEqual(P.findTimes('10h31').map((t) => t.raw), ['10h31']);
  assert.strictEqual(P.findTimes('On Site 09:05:42')[0].seconds, 42);
  assert.deepStrictEqual(P.findTimes('version 1.2.3, 42 places'), []);
  assert.deepStrictEqual(P.findTimes('42:00'), []); // pas une heure valide
});

test('resolveClockTime bascule sur la veille si l\'heure est dans le futur', () => {
  assert.strictEqual(P.resolveClockTime({ hours: 10, minutes: 31 }, NOW), at(10, 31));
  const yesterday = P.resolveClockTime({ hours: 22, minutes: 15 }, NOW);
  assert.strictEqual(yesterday, new Date(2026, 6, 28, 22, 15).getTime());
});

test('resolveClockTime tolère 5 min d\'avance d\'horloge', () => {
  const t = P.resolveClockTime({ hours: 14, minutes: 3 }, NOW);
  assert.strictEqual(t, at(14, 3), 'ne doit pas reculer d\'un jour pour 3 min d\'écart');
});

test('detect ignore <html> et trouve le bon élément (bug v1)', () => {
  const doc = makeDocument(
    h('div', { className: 'user-location' },
      h('span', { className: 'tag' , text: 'On Site' }),
      h('span', { text: '10:31' })
    )
  );
  const state = P.detect(doc, NOW);
  assert.strictEqual(state.status, P.STATUS.ON_SITE);
  assert.strictEqual(state.startMs, at(10, 31));
  assert.strictEqual(state.source, 'clock');
});

test('detect reconnaît "On Site Unsaved"', () => {
  const doc = makeDocument(h('div', { text: 'On Site Unsaved 12:05' }));
  const state = P.detect(doc, NOW);
  assert.strictEqual(state.status, P.STATUS.ON_SITE_UNSAVED);
  assert.strictEqual(state.startMs, at(12, 5));
  assert.ok(P.isOnSite(state.status));
});

test('detect reconnaît "On Site (unsaved)" et la casse variable', () => {
  const doc = makeDocument(h('div', { text: 'ON-SITE (UNSAVED) — 12:05' }));
  assert.strictEqual(P.detect(doc, NOW).status, P.STATUS.ON_SITE_UNSAVED);
});

test('detect préfère un timestamp ISO à l\'heure murale', () => {
  const doc = makeDocument(
    h('div', { text: 'On Site' },
      h('time', { attributes: { datetime: '2026-07-29T09:00:00' }, text: '09:00' })
    )
  );
  const state = P.detect(doc, NOW);
  assert.strictEqual(state.source, 'iso');
  assert.strictEqual(state.startMs, Date.parse('2026-07-29T09:00:00'));
});

test('detect traite un intervalle fermé comme une session terminée', () => {
  const doc = makeDocument(h('div', { text: 'On Site 08:00 - 11:30' }));
  const state = P.detect(doc, NOW);
  assert.strictEqual(state.status, P.STATUS.OFF_SITE);
  assert.strictEqual(state.startMs, null);
});

test('detect rapporte OFF_SITE quand le badge est sorti', () => {
  const doc = makeDocument(h('div', { text: 'Off Site' }));
  assert.strictEqual(P.detect(doc, NOW).status, P.STATUS.OFF_SITE);
});

test('detect rapporte UNKNOWN quand la page ne dit rien', () => {
  const doc = makeDocument(h('div', { text: 'Projets en cours' }));
  const state = P.detect(doc, NOW);
  assert.strictEqual(state.status, P.STATUS.UNKNOWN);
  assert.strictEqual(state.startMs, null);
});

test('detect signale "On Site" sans heure exploitable', () => {
  const doc = makeDocument(h('div', { text: 'On Site' }));
  const state = P.detect(doc, NOW);
  assert.strictEqual(state.status, P.STATUS.ON_SITE);
  assert.strictEqual(state.startMs, null);
  assert.strictEqual(state.source, 'no-time');
});

test('detect choisit le candidat le plus spécifique parmi plusieurs', () => {
  const inner = h('span', { text: 'On Site 10:31' });
  const doc = makeDocument(
    h('section', {},
      h('p', { text: 'Historique : On Site 08:00 - 09:00' }),
      h('div', { className: 'current' }, inner)
    )
  );
  assert.strictEqual(P.detect(doc, NOW).startMs, at(10, 31));
});

/* --- attendance.42lyon.fr/me : reproduction de la page réelle --- */

// À 11:22 : badge à 10:31, la page annonce "expire à 14:31" et "03h08m".
const attendancePage = () => makeDocument(
  h('aside', {},
    h('div', { text: 'ATTENDANCE' }),
    h('div', {},
      h('span', { text: 'LA SESSION EXPIRE À 14:31' }),
      h('div', { text: '03h08m' }),
      h('button', { text: "I'm leaving" })
    )
  ),
  h('main', {},
    h('div', { text: 'Juillet 2026' }),
    h('div', { text: '00:23 / 84:00' }),
    h('div', { className: 'day' },
      h('div', { text: 'On Site 10:07 → 10:31 00:23' }),
      h('div', { text: 'On Site Unsaved 10:31 → 11:22 00:51' })
    )
  )
);

test('attendance : lit l\'échéance affichée par la page', () => {
  const now = at(11, 22);
  const state = P.detect(attendancePage(), now);
  assert.strictEqual(state.expiryMs, at(14, 31), 'échéance mal lue');
  assert.ok(P.isOnSite(state.status));
});

test('attendance : la ligne en cours l\'emporte sur la ligne archivée', () => {
  const now = at(11, 22);
  const state = P.detect(attendancePage(), now);
  // 10:31 = début de "On Site Unsaved", pas 10:07 de la ligne close
  assert.strictEqual(state.startMs, at(10, 31));
  assert.strictEqual(state.status, P.STATUS.ON_SITE_UNSAVED);
});

test('attendance : l\'échéance concorde avec le début détecté', () => {
  const now = at(11, 22);
  const state = P.detect(attendancePage(), now);
  assert.strictEqual(state.expiryMs - state.startMs, P.SESSION_MAX_SECONDS * 1000);
});

test('attendance : une durée "00:51" en fin de ligne ne passe pas pour une heure de badge', () => {
  const now = at(11, 22);
  const state = P.detect(attendancePage(), now);
  assert.notStrictEqual(state.startMs, at(0, 51));
  assert.notStrictEqual(state.startMs, at(0, 23));
});

test('detectExpiry retombe sur le compte à rebours si l\'échéance absolue manque', () => {
  const now = at(11, 22);
  const doc = makeDocument(h('div', { text: '03h08m' }));
  const found = P.detectExpiry(doc, now);
  assert.strictEqual(found.source, 'countdown');
  assert.strictEqual(found.expiryMs, at(14, 30)); // 11:22 + 3h08
});

test('detectExpiry gère une échéance après minuit', () => {
  const now = at(23, 30);
  const doc = makeDocument(h('div', { text: 'LA SESSION EXPIRE À 01:15' }));
  const found = P.detectExpiry(doc, now);
  assert.strictEqual(found.expiryMs, new Date(2026, 6, 30, 1, 15).getTime());
});

test('detectExpiry ne trouve rien sur une page sans session', () => {
  assert.strictEqual(P.detectExpiry(makeDocument(h('div', { text: 'Juillet 2026' })), NOW), null);
});

/* --- notifications --- */

test('decideNotification ne notifie pas tant que l\'échéance est loin', () => {
  const session = { expiryMs: at(14, 31), notifiedCount: 0, lastNotifiedMs: 0 };
  const d = P.decideNotification(session, { warnBeforeSeconds: 30 * 60 }, at(11, 22));
  assert.strictEqual(d.notify, false);
  assert.strictEqual(d.remainingSeconds, 3 * 3600 + 9 * 60);
});

test('decideNotification notifie une seule fois au franchissement du préavis', () => {
  const session = { expiryMs: at(14, 31), notifiedCount: 0, lastNotifiedMs: 0 };
  const settings = { warnBeforeSeconds: 30 * 60, repeatSeconds: 15 * 60 };
  const first = P.decideNotification(session, settings, at(14, 1));
  assert.deepStrictEqual([first.notify, first.kind], [true, 'threshold']);

  session.notifiedCount = 1;
  session.lastNotifiedMs = at(14, 1);
  const second = P.decideNotification(session, settings, at(14, 2));
  assert.strictEqual(second.notify, false, 'pas de spam une minute plus tard');
});

test('decideNotification relance après repeatSeconds', () => {
  const session = { expiryMs: at(14, 31), notifiedCount: 1, lastNotifiedMs: at(14, 1) };
  const d = P.decideNotification(session, { warnBeforeSeconds: 30 * 60, repeatSeconds: 15 * 60 }, at(14, 16));
  assert.deepStrictEqual([d.notify, d.kind], [true, 'repeat']);
});

test('decideNotification passe en alerte imminente dans les 5 dernières minutes', () => {
  const session = { expiryMs: at(14, 31), notifiedCount: 3, lastNotifiedMs: at(14, 26) };
  const d = P.decideNotification(session, { warnBeforeSeconds: 30 * 60, repeatSeconds: 15 * 60 }, at(14, 28));
  assert.deepStrictEqual([d.notify, d.kind], [true, 'logtime_lost_soon']);
  assert.strictEqual(d.remainingSeconds, 180);
});

test('decideNotification se tait une fois l\'échéance passée', () => {
  const session = { expiryMs: at(14, 31), notifiedCount: 4, lastNotifiedMs: at(14, 30) };
  assert.strictEqual(P.decideNotification(session, {}, at(14, 32)).notify, false);
});

test('decideNotification : un préavis court n\'est pas écrasé par l\'alerte des 5 min', () => {
  // mode test : préavis de 60 s -> rien ne doit partir à 5 min de l'échéance
  const session = { expiryMs: at(14, 31), notifiedCount: 0, lastNotifiedMs: 0 };
  const settings = { warnBeforeSeconds: 60, repeatSeconds: 60 };
  assert.strictEqual(P.decideNotification(session, settings, at(14, 27)).notify, false);
  assert.strictEqual(P.decideNotification(session, settings, at(14, 30, 15)).notify, true);
});

test('decideNotification déduit l\'échéance de l\'heure de badge si besoin', () => {
  const session = { startMs: at(10, 31), notifiedCount: 0, lastNotifiedMs: 0 };
  const d = P.decideNotification(session, { warnBeforeSeconds: 30 * 60 }, at(14, 1));
  assert.deepStrictEqual([d.notify, d.kind], [true, 'threshold']);
  assert.strictEqual(d.elapsedSeconds, 3 * 3600 + 30 * 60);
});

test('decideNotification ignore une session sans échéance ni début', () => {
  assert.strictEqual(P.decideNotification({ startMs: null }, {}, NOW).notify, false);
  assert.strictEqual(P.decideNotification(null, {}, NOW).notify, false);
});

test('clampWarnBefore respecte les bornes et le mode test', () => {
  assert.strictEqual(P.clampWarnBefore(30 * 60, false), 1800);
  assert.strictEqual(P.clampWarnBefore(10, false), 60, 'minimum 1 min hors mode test');
  assert.strictEqual(P.clampWarnBefore(10, true), 10, 'mode test : 10 s accepté');
  assert.strictEqual(P.clampWarnBefore(9 * 3600, false), P.SESSION_MAX_SECONDS - 60);
  assert.strictEqual(P.clampWarnBefore('abc', false), P.DEFAULT_SETTINGS.warnBeforeSeconds);
});

test('le préavis par défaut laisse une vraie marge', () => {
  assert.ok(P.DEFAULT_SETTINGS.warnBeforeSeconds >= 15 * 60);
  assert.ok(P.DEFAULT_SETTINGS.warnBeforeSeconds < P.SESSION_MAX_SECONDS);
});

test('formatDuration', () => {
  assert.strictEqual(P.formatDuration(3 * 3600 + 29 * 60), '3h29m');
  assert.strictEqual(P.formatDuration(90), '1m30s');
  assert.strictEqual(P.formatDuration(9), '9s');
  assert.strictEqual(P.formatDuration(-5), '0s');
});

test('computeStats agrège l\'historique', () => {
  const history = [
    { durationSeconds: 3600, alerted: false },
    { durationSeconds: P.LOGTIME_LOST_SECONDS + 60, alerted: true },
    { durationSeconds: 7200, alerted: true }
  ];
  const stats = P.computeStats(history);
  assert.strictEqual(stats.sessions, 3);
  assert.strictEqual(stats.longestSeconds, P.LOGTIME_LOST_SECONDS + 60);
  assert.strictEqual(stats.logtimeLost, 1);
  assert.strictEqual(stats.alerted, 2);
  assert.strictEqual(stats.averageSeconds, Math.round((3600 + P.LOGTIME_LOST_SECONDS + 60 + 7200) / 3));
});

test('computeStats supporte un historique vide', () => {
  assert.deepStrictEqual(P.computeStats([]).sessions, 0);
  assert.deepStrictEqual(P.computeStats(undefined).longestSeconds, 0);
});
