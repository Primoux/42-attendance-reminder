/*
 * fake-api.js - un `browser.*` minimal, en mémoire, pour faire tourner
 * background.js dans Node.
 *
 * On ne simule que ce que background.js touche, mais on respecte deux détails
 * qui comptent : storage.local.set **remplace** la clé (il ne fusionne pas), et
 * tout est asynchrone. Les valeurs sont recopiées à l'entrée comme à la sortie,
 * pour qu'un test ne puisse pas muter l'état du background par accident.
 */

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function createFakeApi() {
  const storage = {};

  const api = {
    // journaux d'appels, lus par les tests
    notified: [],      // options des notifications créées
    cleared: 0,        // nombre de notifications effacées
    createdAlarms: [], // noms des alarmes créées
    badges: [],        // textes de badge successifs
    openedTabs: [],

    _messageListener: null,
    _alarmListener: null,
    _alarms: new Map(),

    runtime: {
      getURL: (path) => `moz-extension://fake/${path}`,
      onMessage: { addListener(fn) { api._messageListener = fn; } },
      onInstalled: { addListener() {} }
    },

    storage: {
      local: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) {
            if (k in storage) out[k] = clone(storage[k]);
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) storage[k] = clone(v);
        }
      },
      onChanged: { addListener() {} }
    },

    notifications: {
      async create(id, options) { api.notified.push(clone(options)); return id; },
      async clear() { api.cleared += 1; return true; },
      onClicked: { addListener() {} }
    },

    alarms: {
      create(name, info) { api.createdAlarms.push(name); api._alarms.set(name, info); },
      // volontairement à promesse, comme browser.* : la variante à callback est
      // testée à part
      async get(name) { return api._alarms.get(name) || null; },
      onAlarm: { addListener(fn) { api._alarmListener = fn; } }
    },

    action: {
      async setBadgeText({ text }) { api.badges.push(text); },
      async setBadgeBackgroundColor() {}
    },

    tabs: {
      async query() { return []; },
      async create({ url }) { api.openedTabs.push(url); return { id: 1 }; },
      async update() {},
      async reload() {}
    },

    // raccourcis de lecture pour les tests
    state: () => clone(storage.state),
    settings: () => clone(storage.settings),
    seed: (key, value) => { storage[key] = clone(value); },
    lastNotification: () => api.notified[api.notified.length - 1] || null,
    lastBadge: () => (api.badges.length ? api.badges[api.badges.length - 1] : null),
    reset: () => { api.notified = []; api.cleared = 0; api.badges = []; }
  };

  return api;
}

module.exports = { createFakeApi };
