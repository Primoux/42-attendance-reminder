/*
 * Tests de content.js - la relecture de la page côté serveur. La page
 * attendance ne se met pas à jour après un badge : sans relecture, il fallait
 * un F5 pour que le rebadge soit vu.
 *
 * Comme background.js, content.js n'est pas un module : on l'exécute dans un
 * `vm` avec un faux `document`, un faux `fetch` et une horloge qu'on avance à
 * la main.
 *
 * `node test/content.test.js`.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { dom } = require('./fake-dom');

// ---------------------------------------------------------------- harnais

let passed = 0;
const failures = [];
const pending = [];
function test(name, fn) { pending.push({ name, fn }); }

const root = path.join(__dirname, '..');
const parserSrc = fs.readFileSync(path.join(root, 'parser.js'), 'utf8');
const contentSrc = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const at = (h, m, s = 0) => new Date(2026, 7, 11, h, m, s, 0).getTime();

/**
 * Charge content.js sur une page qui affiche `pageTexts`.
 * -> { sent, clock, tick, server } : les messages partis au background,
 * l'horloge, le tick de 15 s, et la réponse que servira le prochain fetch.
 */
async function load(pageTexts, startMs) {
  const clock = { now: startMs };
  const sent = [];
  const server = { texts: pageTexts, ok: true, fails: false, calls: 0 };
  let intervalFn = null;

  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }

  const document = dom(...pageTexts);
  document.addEventListener = () => {};
  document.visibilityState = 'visible';

  const sandbox = {
    browser: {
      runtime: { sendMessage: async (message) => { sent.push(message); } },
      storage: {
        local: { get: async () => ({}) },
        onChanged: { addListener() {} }
      }
    },
    console: { log() {}, warn() {} },
    Date: FakeDate, Math, Number, JSON, URL,
    document,
    location: { href: 'https://attendance.42lyon.fr/me', pathname: '/me' },
    setInterval: (fn) => { intervalFn = fn; return 1; },
    clearInterval() {},
    setTimeout: () => 1,
    // pas de MutationObserver : content.js doit s'en passer sans casser
    fetch: async () => {
      server.calls += 1;
      if (server.fails) throw new Error('réseau coupé');
      return { ok: server.ok, status: server.ok ? 200 : 500, text: async () => 'html' };
    },
    DOMParser: class { parseFromString() { return dom(...server.texts); } }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(parserSrc, context, { filename: 'parser.js' });
  vm.runInContext(contentSrc, context, { filename: 'content.js' });
  await flush();

  /** Avance l'horloge puis joue le tick de 15 s, relecture comprise. */
  const tick = async (advanceMs) => {
    clock.now += advanceMs;
    intervalFn();
    await flush();
    await flush();
  };
  return { sent, clock, tick, server };
}

const last = (sent) => sent[sent.length - 1].state;
const MIN = 60 * 1000;

// ------------------------------------------------------------------ tests

test('au chargement, la page fait foi et rien n\'est redemandé', async () => {
  const { sent, server } = await load(['On Site', 'session expires at 14:31'], at(12, 0));
  assert.strictEqual(last(sent).expiryMs, at(14, 31));
  assert.strictEqual(server.calls, 0);
});

test('un rebadge est vu sans F5, à la relecture suivante', async () => {
  const { sent, tick, server } = await load(['On Site', 'session expires at 14:31'], at(12, 0));
  server.texts = ['On Site', 'session expires at 16:04'];

  await tick(4 * MIN);
  assert.strictEqual(server.calls, 0); // pas avant 5 min
  assert.strictEqual(last(sent).expiryMs, at(14, 31));

  await tick(1 * MIN);
  assert.strictEqual(server.calls, 1);
  assert.strictEqual(last(sent).expiryMs, at(16, 4));
  assert.strictEqual(last(sent).source, 'fetch:expiry');
});

test('le serveur confirme la page : la page reste la source', async () => {
  // la réponse brute est en UTC : ses heures de présence ne doivent pas
  // remplacer celles, locales, de la page affichée
  const page = ['On Site Unsaved 10:31 12:05 01:34', 'session expires at 14:31'];
  const { sent, tick, server } = await load(page, at(12, 0));
  server.texts = ['On Site Unsaved 08:31 10:05 01:34', 'session expires at 14:31'];
  await tick(5 * MIN);
  assert.strictEqual(server.calls, 1);
  assert.strictEqual(last(sent).startMs, at(10, 31));
  assert.strictEqual(last(sent).source, 'live-range+expiry');
});

test('après un rebadge, le début est l\'heure du badge, pas une heure UTC', async () => {
  const page = ['On Site Unsaved 10:31 12:00 01:29', 'session expires at 14:31'];
  const { sent, tick, server } = await load(page, at(12, 0));
  server.texts = ['On Site Unsaved 10:04 10:05 00:01', 'session expires at 16:04'];
  await tick(5 * MIN);
  assert.strictEqual(last(sent).expiryMs, at(16, 4));
  assert.strictEqual(last(sent).startMs, at(12, 4));
});

test('un badge out est vu sans F5', async () => {
  const { sent, tick, server } = await load(['On Site', 'session expires at 14:31'], at(12, 0));
  server.texts = ['Off Site'];
  await tick(5 * MIN);
  assert.strictEqual(last(sent).status, 'off_site');
});

test('à l\'approche du préavis, la relecture passe à une par minute', async () => {
  // 14:00, échéance 14:31 : dans la fenêtre préavis (30 min) + marge
  const { tick, server } = await load(['On Site', 'session expires at 14:31'], at(14, 0));
  await tick(1 * MIN);
  assert.strictEqual(server.calls, 1);
  await tick(1 * MIN);
  assert.strictEqual(server.calls, 2);
});

test('réseau coupé ou erreur serveur : on garde ce que la page affiche', async () => {
  const { sent, tick, server } = await load(['On Site', 'session expires at 14:31'], at(12, 0));
  server.fails = true;
  await tick(5 * MIN);
  assert.strictEqual(last(sent).expiryMs, at(14, 31));

  server.fails = false;
  server.ok = false;
  await tick(5 * MIN);
  assert.strictEqual(server.calls, 2);
  assert.strictEqual(last(sent).expiryMs, at(14, 31));
});

test('session 42 expirée (page de login) : la relecture est ignorée', async () => {
  const { sent, tick, server } = await load(['On Site', 'session expires at 14:31'], at(12, 0));
  server.texts = ['Sign in with 42'];
  await tick(5 * MIN);
  assert.strictEqual(last(sent).status, 'on_site');
  assert.strictEqual(last(sent).expiryMs, at(14, 31));
});

// ---------------------------------------------------------------- bilan

(async () => {
  for (const { name, fn } of pending) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      failures.push({ name, err });
    }
  }
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
})();
