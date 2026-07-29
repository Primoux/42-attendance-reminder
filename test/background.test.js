/*
 * Charge parser.js + background.js dans un faux WebExtension API et vérifie
 * que l'initialisation ne plante pas, puis exerce la machine à états.
 */

const { test } = require('./tiny.js');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Faux `browser` : promesses partout, comme Firefox. */
function makeFakeBrowser() {
  const store = {};
  const captured = { messages: [], notifications: [], alarms: [], listeners: {} };

  const fake = {
    _store: store,
    _captured: captured,
    storage: {
      local: {
        get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
          return Promise.resolve(out);
        },
        set(obj) {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
          return Promise.resolve();
        }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      onMessage: { addListener(fn) { captured.listeners.message = fn; } },
      onInstalled: { addListener(fn) { captured.listeners.installed = fn; } }
    },
    notifications: {
      create(id, opts) { captured.notifications.push(Object.assign({ id }, opts)); return Promise.resolve(id); },
      clear() { return Promise.resolve(true); },
      onClicked: { addListener() {} }
    },
    alarms: {
      create(name, opts) { captured.alarms.push({ name, opts }); },
      onAlarm: { addListener(fn) { captured.listeners.alarm = fn; } }
    },
    tabs: {
      _open: [],
      query(info) { captured.messages.push({ query: info }); return Promise.resolve(fake.tabs._open); },
      update(id, props) { captured.messages.push({ update: id, props }); return Promise.resolve({}); },
      reload(id) { captured.messages.push({ reload: id }); return Promise.resolve(); },
      create(props) { captured.messages.push({ create: props }); return Promise.resolve({}); }
    }
  };
  return fake;
}

/** Évalue parser.js + background.js dans un même scope, comme le fait Firefox. */
function loadBackground(fakeBrowser) {
  const src = ['parser.js', 'background.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n;\n');
  const factory = new Function(
    'browser', 'chrome', 'console', 'module',
    `${src}\n;return { handleBadgeState, evaluate, LOGTIME_LOST_SECONDS, STATUS };`
  );
  const quietConsole = { log() {}, warn() {}, error() {} };
  return factory(fakeBrowser, undefined, quietConsole, { exports: {} });
}

test('background.js se charge sans exception et enregistre ses listeners', () => {
  const fake = makeFakeBrowser();
  loadBackground(fake);
  assert.ok(fake._captured.listeners.message, 'listener runtime.onMessage manquant');
  assert.ok(fake._captured.listeners.alarm, 'listener alarms.onAlarm manquant');
  assert.strictEqual(fake._captured.alarms.length, 1, 'alarme périodique non créée');
});

test('getStatus répond au popup', async () => {
  const fake = makeFakeBrowser();
  loadBackground(fake);
  const info = await fake._captured.listeners.message({ action: 'getStatus' });
  assert.ok(info, 'aucune réponse : le popup afficherait "Background injoignable"');
  assert.strictEqual(info.session, null);
  assert.strictEqual(info.stats.sessions, 0);
  assert.ok(info.sessionMaxSeconds > 0);
  assert.ok(info.settings.warnBeforeSeconds > 0);
});

test('une session est créée, notifiée une fois, puis clôturée au badge out', async () => {
  const fake = makeFakeBrowser();
  const bg = loadBackground(fake);
  const send = (msg) => fake._captured.listeners.message(msg);
  const start = Date.now() - 3.6 * 3600 * 1000; // échéance dans 24 min < préavis 30 min

  await send({ action: 'badgeState', state: { status: 'on_site', startMs: start }, at: Date.now() });
  assert.strictEqual(fake._captured.notifications.length, 1, 'pas notifié au franchissement du seuil');

  // même session, une minute plus tard : pas de spam
  await send({ action: 'badgeState', state: { status: 'on_site', startMs: start }, at: Date.now() + 60000 });
  assert.strictEqual(fake._captured.notifications.length, 1, 'notification en double');

  // badge out : la session part dans l'historique
  await send({ action: 'badgeState', state: { status: 'off_site', startMs: null }, at: Date.now() });
  const info = await send({ action: 'getStatus' });
  assert.strictEqual(info.session, null, 'session non réinitialisée après badge out');
  assert.strictEqual(info.stats.sessions, 1);
  assert.strictEqual(info.stats.alerted, 1);
});

test('un statut unknown ne détruit pas la session en cours', async () => {
  const fake = makeFakeBrowser();
  loadBackground(fake);
  const send = (msg) => fake._captured.listeners.message(msg);
  const start = Date.now() - 600 * 1000;

  await send({ action: 'badgeState', state: { status: 'on_site', startMs: start }, at: Date.now() });
  await send({ action: 'badgeState', state: { status: 'unknown', startMs: null }, at: Date.now() });
  const info = await send({ action: 'getStatus' });
  assert.ok(info.session, 'la session a été perdue sur un statut unknown');
  assert.strictEqual(info.session.startMs, start);
});

test('openIntra ouvre la page attendance quand aucun onglet n\'est ouvert', async () => {
  const fake = makeFakeBrowser();
  loadBackground(fake);
  const res = await fake._captured.listeners.message({ action: 'openIntra' });
  assert.strictEqual(res.reused, false);
  const created = fake._captured.messages.find((m) => m.create);
  assert.ok(created, 'aucun onglet créé');
  assert.strictEqual(created.create.url, 'https://attendance.42lyon.fr/me');
});

test('openIntra réutilise et recharge un onglet attendance existant', async () => {
  const fake = makeFakeBrowser();
  fake.tabs._open = [{ id: 7, url: 'https://attendance.42lyon.fr/me' }];
  loadBackground(fake);
  const res = await fake._captured.listeners.message({ action: 'openIntra' });
  assert.strictEqual(res.reused, true);
  assert.ok(fake._captured.messages.find((m) => m.update === 7), 'onglet non activé');
  // le reload est indispensable : sans lui l'onglet garde son absence de content script
  assert.ok(fake._captured.messages.find((m) => m.reload === 7), 'onglet non rechargé');
  assert.ok(!fake._captured.messages.find((m) => m.create), 'onglet créé en double');
});

test('rebadger repousse l\'échéance et relance le cycle d\'alerte', async () => {
  const fake = makeFakeBrowser();
  loadBackground(fake);
  const send = (msg) => fake._captured.listeners.message(msg);
  const now = Date.now();
  const start = now - 3.6 * 3600 * 1000;

  await send({ action: 'badgeState', state: { status: 'on_site', startMs: start }, at: now });
  assert.strictEqual(fake._captured.notifications.length, 1);

  // clock-in : l'échéance passe à +4h, plus rien ne doit partir
  await send({
    action: 'badgeState',
    state: { status: 'on_site', startMs: start, expiryMs: now + 4 * 3600 * 1000 },
    at: now
  });
  assert.strictEqual(fake._captured.notifications.length, 1, 'notification après un rebadge');

  const info = await send({ action: 'getStatus' });
  assert.strictEqual(info.session.notifiedCount, 0, 'cycle d\'alerte non réinitialisé');
  assert.strictEqual(info.session.startMs, start, 'le début de présence doit être conservé');
  assert.ok(info.remainingSeconds > 3.9 * 3600);
});

test('resetStats vide l\'historique', async () => {
  const fake = makeFakeBrowser();
  loadBackground(fake);
  const send = (msg) => fake._captured.listeners.message(msg);
  const start = Date.now() - 3600 * 1000;
  await send({ action: 'badgeState', state: { status: 'on_site', startMs: start }, at: Date.now() });
  await send({ action: 'badgeState', state: { status: 'off_site', startMs: null }, at: Date.now() });
  assert.strictEqual((await send({ action: 'getStatus' })).stats.sessions, 1);
  await send({ action: 'resetStats' });
  assert.strictEqual((await send({ action: 'getStatus' })).stats.sessions, 0);
});
