/*
 * Tests de background.js - la machine à états des sessions et des
 * notifications. C'est là que se sont logés tous les bugs de la 1.0.1 :
 * session de la veille fusionnée avec le badge du jour, alarme jamais
 * déclenchée, notification répétée toutes les 15 s.
 *
 * background.js n'est pas un module : on l'exécute dans un `vm` avec un faux
 * `browser` et les fonctions de parser.js, exactement comme le fait Firefox
 * (`manifest.json` charge les deux scripts dans la même page).
 *
 * `node test/background.test.js`.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createFakeApi } = require('./fake-api');
const { dom } = require('./fake-dom');

// ---------------------------------------------------------------- harnais

let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) { currentGroup = name; }

const pending = [];
function test(name, fn) { pending.push({ name: `${currentGroup} > ${name}`, fn }); }

async function run() {
  for (const { name, fn } of pending) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      failures.push({ name, err });
    }
  }
}

// ------------------------------------------------------------- chargement

const root = path.join(__dirname, '..');
const parserSrc = fs.readFileSync(path.join(root, 'parser.js'), 'utf8');
const backgroundSrc = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

/** Laisse les promesses en cours se résoudre (l'init du background est async). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Charge parser.js puis background.js dans un contexte neuf.
 * -> { api, bg } où `bg` expose les fonctions déclarées (les `function` du
 * script atterrissent sur l'objet global du contexte).
 */
async function load(seed, extras) {
  const api = createFakeApi();
  if (seed) for (const [k, v] of Object.entries(seed)) api.seed(k, v);
  const sandbox = Object.assign(
    { browser: api, console: { log() {}, warn() {} }, Date, Math, Number, JSON, URL },
    extras
  );
  const context = vm.createContext(sandbox);
  vm.runInContext(parserSrc, context, { filename: 'parser.js' });
  vm.runInContext(backgroundSrc, context, { filename: 'background.js' });
  await flush(); // `ensureAlarm()` est asynchrone : on attend qu'elle ait tranché
  return { api, bg: context };
}

// ------------------------------------------------------------------ temps

const at = (h, m, s = 0) => new Date(2026, 7, 11, h, m, s, 0).getTime();
const atOffsetDay = (days, h, m) => new Date(2026, 7, 11 + days, h, m, 0, 0).getTime();

/** Message tel que l'enverrait content.js. */
const badge = (expiryMs, atMs, extra = {}) => Object.assign({
  action: 'badgeState',
  state: { status: 'on_site', startMs: expiryMs - 4 * 3600 * 1000, expiryMs },
  at: atMs
}, extra);

const offSite = (atMs) => ({ action: 'badgeState', state: { status: 'off_site' }, at: atMs });

// ------------------------------------------------------------- démarrage

group('démarrage');

test('l\'alarme d\'une minute est créée au chargement', async () => {
  const { api } = await load();
  assert.deepStrictEqual(api.createdAlarms, ['42-reminder-tick']);
});

test('un réveil ultérieur ne recrée pas l\'alarme existante', async () => {
  const { api, bg } = await load();
  await bg.ensureAlarm();
  await bg.ensureAlarm();
  // recréer l'alarme remettrait son compte à une minute à zéro : avec un onglet
  // ouvert (un message toutes les 15 s), elle ne sonnerait jamais
  assert.deepStrictEqual(api.createdAlarms, ['42-reminder-tick']);
});

test('les écouteurs sont branchés', async () => {
  const { api } = await load();
  assert.strictEqual(typeof api._messageListener, 'function');
  assert.strictEqual(typeof api._alarmListener, 'function');
});

// ------------------------------------------------------- cycle de session

group('cycle de session');

test('un badge ouvre une session avec son échéance', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(10, 31)));
  const { session } = api.state();
  assert.strictEqual(session.expiryMs, at(14, 31));
  assert.strictEqual(session.startMs, at(10, 31));
  assert.strictEqual(api.notified.length, 0); // encore loin du seuil
});

test('rien ne part tant que le préavis n\'est pas franchi', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(13, 0)));
  assert.strictEqual(api.notified.length, 0);
});

test('le franchissement du préavis notifie une fois', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10)));
  assert.strictEqual(api.notified.length, 1);
  assert.match(api.lastNotification().title, /Rebadge bientôt/);
});

test('badge out : la session et la notification disparaissent', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10)));
  api.reset();
  await bg.handleBadgeState(offSite(at(14, 15)));
  assert.strictEqual(api.state().session, null);
  assert.strictEqual(api.cleared, 1);
});

test('une page muette (unknown) ne fait pas perdre le timer', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(13, 0)));
  await bg.handleBadgeState({ action: 'badgeState', state: { status: 'unknown' }, at: at(13, 1) });
  assert.strictEqual(api.state().session.expiryMs, at(14, 31));
});

// -------------------------------------------------------------- sans page

group('sans onglet ouvert');

test('l\'alarme relance sans qu\'aucune page ne parle', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10))); // 1re notification
  api.reset();
  await bg.evaluate(at(14, 20)); // 10 min plus tard, onglet fermé
  assert.strictEqual(api.notified.length, 0); // repeat = 15 min
  await bg.evaluate(at(14, 26));
  assert.strictEqual(api.notified.length, 1);
  assert.match(api.lastNotification().title, /Logtime lost imminent/);
});

test('échéance dépassée : une dernière alerte, puis la session est purgée', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10)));
  api.reset();
  await bg.evaluate(at(14, 32));
  assert.strictEqual(api.notified.length, 1);
  assert.match(api.lastNotification().title, /Logtime perdu/);
  assert.strictEqual(api.state().session, null);
});

test('la dernière alerte reste affichée : on ne l\'efface pas en purgeant', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10)));
  api.reset();
  await bg.evaluate(at(14, 32));
  assert.strictEqual(api.cleared, 0);
});

test('après la purge, plus rien ne part', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10)));
  await bg.evaluate(at(14, 32));
  api.reset();
  for (const m of [40, 50, 60]) await bg.evaluate(at(14, m));
  assert.strictEqual(api.notified.length, 0);
});

test('réveil après une veille machine : l\'alerte finale part quand même', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(11, 0))); // rien à notifier alors
  api.reset();
  await bg.evaluate(at(18, 0)); // la machine dormait, aucune alarme entre-temps
  assert.strictEqual(api.notified.length, 1);
  assert.match(api.lastNotification().title, /Logtime perdu/);
});

// ---------------------------------------------------------- anti-rechute

group('anti-rechute');

test('badgé au-delà de l\'échéance : pas de recréation à chaque tick', async () => {
  const { api, bg } = await load();
  // la page annonce une échéance déjà passée (badgé depuis > 4 h sans rebadger)
  for (let i = 0; i < 5; i += 1) {
    await bg.handleBadgeState(badge(at(14, 31), at(15, 0, i * 15)));
  }
  assert.strictEqual(api.state().session, null);
  // ouvrir une session pour la purger aussitôt notifierait à chaque tick
  assert.strictEqual(api.notified.length, 0);
});

test('le badge du lendemain n\'hérite pas de la session de la veille', async () => {
  const { api, bg } = await load({
    state: {
      session: {
        startMs: atOffsetDay(-1, 9, 0),
        expiryMs: atOffsetDay(-1, 13, 0),
        status: 'on_site',
        lastSeenMs: atOffsetDay(-1, 12, 0),
        notifiedCount: 3,
        lastNotifiedMs: atOffsetDay(-1, 12, 0)
      },
      lastStatus: 'on_site'
    }
  });
  await bg.handleBadgeState(badge(at(14, 31), at(10, 31)));
  const { session } = api.state();
  assert.strictEqual(session.startMs, at(10, 31)); // et pas 9:00 la veille
  assert.strictEqual(session.notifiedCount, 0);
});

test('l\'échéance déduite d\'un compte à rebours ne relance pas le cycle', async () => {
  const { api, bg } = await load();
  // "03h08m" relu toutes les 15 s : maintenant + reste dérive de quelques secondes
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10)));
  assert.strictEqual(api.notified.length, 1);
  api.reset();
  for (let i = 1; i <= 8; i += 1) {
    await bg.handleBadgeState(badge(at(14, 31, i * 15), at(14, 10, i * 15)));
  }
  // sans tolérance, chaque lecture passait pour un rebadge -> notifiedCount
  // remis à zéro -> une notification "threshold" toutes les 15 s
  assert.strictEqual(api.notified.length, 0);
  assert.strictEqual(api.state().session.expiryMs, at(14, 31));
});

test('un vrai rebadge, lui, relance le cycle et garde l\'heure d\'arrivée', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10)));
  api.reset();
  await bg.handleBadgeState(badge(at(18, 20), at(14, 20)));
  const { session } = api.state();
  assert.strictEqual(session.expiryMs, at(18, 20));
  assert.strictEqual(session.notifiedCount, 0);
  assert.strictEqual(session.startMs, at(10, 31)); // la présence court toujours
  assert.strictEqual(api.notified.length, 0);      // et on repart en silence
});

// ------------------------------------------------------------- remontées

group('relecture du serveur sans onglet');

/**
 * Un serveur attendance factice : `texts` est ce que rendra la prochaine
 * relecture, à passer en `extras` de load().
 */
function fakeServer(texts) {
  const server = { texts, calls: 0, ok: true, fails: false, url: 'https://attendance.42lyon.fr/me' };
  server.extras = {
    fetch: async () => {
      server.calls += 1;
      if (server.fails) throw new Error('réseau coupé');
      return { ok: server.ok, status: server.ok ? 200 : 500, url: server.url, text: async () => 'html' };
    },
    DOMParser: class { parseFromString() { return dom(...server.texts); } }
  };
  return server;
}

test('un rebadge est vu sans onglet : l\'échéance est repoussée, pas d\'alerte', async () => {
  const server = fakeServer(['On Site', 'session expires at 16:04']);
  const { api, bg } = await load(null, server.extras);
  await bg.handleBadgeState(badge(at(14, 31), at(12, 0))); // puis l'onglet est fermé
  api.reset();

  await bg.onTick(at(14, 5)); // dans la fenêtre d'alerte de l'ancienne échéance
  assert.strictEqual(server.calls, 1);
  assert.strictEqual(api.state().session.expiryMs, at(16, 4));
  assert.strictEqual(api.notified.length, 0);
  assert.strictEqual(api.state().session.startMs, at(10, 31)); // l'arrivée est conservée
});

test('un onglet qui rapporte : le background ne relit rien', async () => {
  const server = fakeServer(['On Site', 'session expires at 16:04']);
  const { api, bg } = await load(null, server.extras);
  await bg.handleBadgeState(badge(at(14, 31), at(12, 0)));
  await bg.onTick(at(12, 1));
  assert.strictEqual(server.calls, 0);
  assert.strictEqual(api.state().session.expiryMs, at(14, 31));
});

test('un badge out est vu sans onglet', async () => {
  const server = fakeServer(['Off Site']);
  const { api, bg } = await load(null, server.extras);
  await bg.handleBadgeState(badge(at(14, 31), at(12, 0)));
  await bg.onTick(at(12, 10));
  assert.strictEqual(api.state().session, null);
  assert.strictEqual(api.state().lastStatus, 'off_site');
});

test('un premier badge est vu sans jamais ouvrir attendance', async () => {
  const server = fakeServer(['On Site Unsaved', 'session expires at 14:31']);
  const { api, bg } = await load(null, server.extras);
  await bg.onTick(at(10, 40));
  assert.strictEqual(api.state().session.expiryMs, at(14, 31));
  assert.strictEqual(api.lastBadge(), '3h');
});

test('cadence : 5 min avec une session, 1 min près du préavis, 15 min sans session', async () => {
  const server = fakeServer(['On Site', 'session expires at 14:31']);
  const { bg } = await load(null, server.extras);
  await bg.handleBadgeState(badge(at(14, 31), at(12, 0)));

  await bg.onTick(at(12, 5));
  assert.strictEqual(server.calls, 1);
  await bg.onTick(at(12, 8));
  assert.strictEqual(server.calls, 1);
  await bg.onTick(at(12, 10));
  assert.strictEqual(server.calls, 2);

  await bg.onTick(at(13, 58)); // préavis 30 min + marge : une par minute
  await bg.onTick(at(13, 59));
  assert.strictEqual(server.calls, 4);

  server.texts = ['Off Site'];
  await bg.onTick(at(14, 0)); // badge out : plus de session
  assert.strictEqual(server.calls, 5);
  await bg.onTick(at(14, 10));
  assert.strictEqual(server.calls, 5);
  await bg.onTick(at(14, 15));
  assert.strictEqual(server.calls, 6);
});

test('pas connecté, erreur ou réseau coupé : la session est gardée', async () => {
  const server = fakeServer(['Sign in with 42']);
  const { api, bg } = await load(null, server.extras);
  await bg.handleBadgeState(badge(at(14, 31), at(12, 0)));

  await bg.onTick(at(12, 5)); // page de connexion servie par attendance
  server.texts = ['Off Site'];
  server.url = 'https://auth.42.fr/login';
  await bg.onTick(at(12, 10)); // redirigé vers la connexion 42
  server.url = 'https://attendance.42lyon.fr/me';
  server.ok = false;
  await bg.onTick(at(12, 15));
  server.fails = true;
  await bg.onTick(at(12, 20));

  assert.strictEqual(server.calls, 4);
  assert.strictEqual(api.state().session.expiryMs, at(14, 31));
});

test('accès à attendance non accordé : aucune requête, et le popup le sait', async () => {
  const server = fakeServer(['On Site', 'session expires at 16:04']);
  const { api, bg } = await load(null, server.extras);
  api.hostGranted = false;
  await bg.onTick(at(10, 40));
  assert.strictEqual(server.calls, 0);
  assert.strictEqual((await api._messageListener({ action: 'getStatus' })).hostPermission, false);

  api.hostGranted = true;
  await bg.onTick(at(10, 41));
  assert.strictEqual(server.calls, 1);
  assert.strictEqual((await api._messageListener({ action: 'getStatus' })).hostPermission, true);
});

test('sans DOM ni fetch, le battement décide quand même', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(12, 0)));
  api.reset();
  await bg.onTick(at(14, 5));
  assert.strictEqual(api.notified.length, 1);
});

group('remontées au popup');

test('une notification refusée est mémorisée', async () => {
  const { api, bg } = await load();
  api.notifications.create = async () => { throw new Error('notifications désactivées'); };
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10)));
  assert.match(api.state().notifyError.message, /désactivées/);
});

test('une notification qui repasse efface l\'erreur', async () => {
  const { api, bg } = await load();
  const create = api.notifications.create;
  api.notifications.create = async () => { throw new Error('boum'); };
  await bg.handleBadgeState(badge(at(14, 31), at(14, 10)));
  api.notifications.create = create;
  await bg.evaluate(at(14, 26));
  assert.strictEqual(api.state().notifyError, null);
});

test('getStatus masque une session dont l\'échéance est passée', async () => {
  const { api, bg } = await load({
    state: {
      session: { startMs: at(9, 0), expiryMs: at(13, 0), status: 'on_site', lastSeenMs: at(12, 0) },
      lastStatus: 'on_site'
    }
  });
  const info = await api._messageListener({ action: 'getStatus' });
  assert.strictEqual(info.session, null);
  assert.strictEqual(info.expiryMs, null);
  assert.strictEqual(info.lastStatus, 'on_site'); // le popup peut dire "badgé, échéance dépassée"
});

test('getStatus dit si un onglet attendance est ouvert', async () => {
  const { api } = await load();
  let info = await api._messageListener({ action: 'getStatus' });
  assert.strictEqual(info.attendanceTabOpen, false);

  api.tabs.query = async () => [{ id: 7 }];
  info = await api._messageListener({ action: 'getStatus' });
  assert.strictEqual(info.attendanceTabOpen, true);
});

test('getStatus survit à un tabs.query en échec', async () => {
  const { api } = await load();
  api.tabs.query = async () => { throw new Error('tabs indisponible'); };
  const info = await api._messageListener({ action: 'getStatus' });
  assert.strictEqual(info.attendanceTabOpen, false);
});

test('openAttendance réutilise l\'onglet ouvert, sinon en crée un', async () => {
  const { api, bg } = await load();
  assert.strictEqual((await bg.openAttendance()).reused, false);
  assert.strictEqual(api.openedTabs.length, 1);

  api.tabs.query = async () => [{ id: 7 }];
  assert.strictEqual((await bg.openAttendance()).reused, true);
  assert.strictEqual(api.openedTabs.length, 1);
});

// ----------------------------------------------------------------- badge

group('badge de l\'icône');

test('le temps restant s\'affiche sur l\'icône', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(12, 0)));
  assert.strictEqual(api.lastBadge(), '2h'); // 2h31 restantes, arrondi vers le bas
  await bg.evaluate(at(14, 10));
  assert.strictEqual(api.lastBadge(), '21m');
});

test('sans session, le badge est vide', async () => {
  const { api, bg } = await load();
  await bg.handleBadgeState(badge(at(14, 31), at(12, 0)));
  await bg.handleBadgeState(offSite(at(12, 30)));
  assert.strictEqual(api.lastBadge(), '');
});

// ---------------------------------------------------------------- bilan

run().then(() => {
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
});
