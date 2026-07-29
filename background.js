/*
 * background.js - source de vérité de l'état de session et des notifications.
 * En MV3 la page background est non-persistante : tout l'état vit dans
 * storage.local, jamais en mémoire.
 */

const api = typeof browser !== 'undefined' ? browser : chrome;

const ALARM_NAME = '42-reminder-tick';
const HISTORY_MAX = 50;
const NOTIFICATION_ID = '42-reminder';
const ICON_URL = api.runtime.getURL('icon-48.svg');

const EMPTY_STATE = {
  session: null,   // { startMs, status, lastSeenMs, notifiedCount, lastNotifiedMs, alerted }
  history: [],
  lastStatus: STATUS.UNKNOWN
};

async function getSettings() {
  const stored = await api.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
}

async function getState() {
  const stored = await api.storage.local.get('state');
  return Object.assign({}, EMPTY_STATE, stored.state || {});
}

async function setState(state) {
  await api.storage.local.set({ state });
}

function log(settings, ...args) {
  if (settings.debug) console.log('[42 Reminder/bg]', ...args);
}

/** Clôt la session courante et la range dans l'historique. */
function closeSession(state, endMs) {
  if (!state.session || !state.session.startMs) {
    state.session = null;
    return null;
  }
  const durationSeconds = Math.max(0, Math.round((endMs - state.session.startMs) / 1000));
  const entry = {
    startMs: state.session.startMs,
    endMs,
    durationSeconds,
    alerted: Boolean(state.session.alerted)
  };
  state.history = [entry].concat(state.history || []).slice(0, HISTORY_MAX);
  state.session = null;
  return entry;
}

async function handleBadgeState(message) {
  const settings = await getSettings();
  const state = await getState();
  const incoming = message.state || {};
  const now = message.at || Date.now();

  if (isOnSite(incoming.status) && (incoming.startMs || incoming.expiryMs)) {
    const current = state.session;
    if (!current) {
      state.session = {
        startMs: incoming.startMs || null,
        expiryMs: incoming.expiryMs || null,
        status: incoming.status,
        lastSeenMs: now,
        notifiedCount: 0,
        lastNotifiedMs: 0,
        alerted: false
      };
      log(settings, 'nouvelle session, échéance', formatClock(sessionExpiry(state.session)));
    } else {
      // Rebadger repousse l'échéance : c'est un nouveau cycle d'alerte, mais la
      // même présence — on garde le début le plus ancien et l'historique.
      if (incoming.expiryMs && incoming.expiryMs !== current.expiryMs) {
        log(settings, 'échéance repoussée à', formatClock(incoming.expiryMs));
        current.expiryMs = incoming.expiryMs;
        current.notifiedCount = 0;
        current.lastNotifiedMs = 0;
      }
      if (incoming.startMs && (!current.startMs || incoming.startMs < current.startMs)) {
        current.startMs = incoming.startMs;
      }
      current.lastSeenMs = now;
      current.status = incoming.status;
    }
  } else if (incoming.status === STATUS.OFF_SITE) {
    if (state.session) {
      const closed = closeSession(state, now);
      log(settings, 'badge out détecté, session de', formatDuration(closed.durationSeconds));
      await api.notifications.clear(NOTIFICATION_ID).catch(() => {});
    }
  }
  // STATUS.UNKNOWN : la page ne dit rien (mauvaise page, DOM changé) -> on garde
  // la session telle quelle plutôt que de perdre le timer.

  state.lastStatus = incoming.status || STATUS.UNKNOWN;
  await setState(state);
  await evaluate(now, settings, state);
}

async function evaluate(now, settings, preloadedState) {
  const s = settings || (await getSettings());
  const state = preloadedState || (await getState());
  if (!state.session) return;

  const decision = decideNotification(state.session, s, now);
  if (!decision.notify) return;

  const remaining = formatDuration(decision.remainingSeconds);
  const expiresAt = formatClock(sessionExpiry(state.session));
  const presence = decision.elapsedSeconds === null
    ? ''
    : ` (${formatDuration(decision.elapsedSeconds)} sur place)`;

  let title = '⏰ Rebadge bientôt';
  let body = `Logtime lost dans ${remaining}, à ${expiresAt}.${presence}`;
  if (decision.kind === 'logtime_lost_soon') {
    title = '🚨 Logtime lost imminent !';
    body = `Plus que ${remaining} avant ${expiresAt}.${presence}`;
  } else if (decision.kind === 'repeat') {
    title = '⏰ Toujours badgé';
  }

  try {
    await api.notifications.create(NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: ICON_URL,
      title,
      message: body
    });
  } catch (err) {
    console.warn('[42 Reminder/bg] notification impossible:', err);
    return;
  }

  state.session.notifiedCount = (state.session.notifiedCount || 0) + 1;
  state.session.lastNotifiedMs = now;
  state.session.alerted = true;
  await setState(state);
  log(s, `notification "${decision.kind}" envoyée (${elapsed})`);
}

/**
 * Ouvre l'intra. Si un onglet intra existe déjà, on l'active *et on le
 * recharge* : après un rechargement de l'extension, les onglets déjà ouverts
 * n'ont plus de content script et ne rapportent donc plus rien.
 */
const ATTENDANCE_URL = 'https://attendance.42lyon.fr/me';

async function openIntra() {
  try {
    const tabs = await api.tabs.query({ url: '*://attendance.42lyon.fr/*' });
    if (tabs && tabs.length) {
      await api.tabs.update(tabs[0].id, { active: true });
      await api.tabs.reload(tabs[0].id);
      return { ok: true, reused: true };
    }
  } catch (err) {
    console.warn('[42 Reminder/bg] tabs.query indisponible:', err);
  }
  await api.tabs.create({ url: ATTENDANCE_URL });
  return { ok: true, reused: false };
}

api.runtime.onMessage.addListener((message) => {
  if (!message || !message.action) return undefined;

  switch (message.action) {
    case 'badgeState':
      return handleBadgeState(message).catch((err) => {
        console.warn('[42 Reminder/bg] handleBadgeState:', err);
      });

    case 'getStatus':
      return (async () => {
        const [settings, state] = await Promise.all([getSettings(), getState()]);
        const now = Date.now();
        const expiryMs = sessionExpiry(state.session);
        return {
          settings,
          session: state.session,
          lastStatus: state.lastStatus,
          expiryMs,
          remainingSeconds: expiryMs ? Math.round((expiryMs - now) / 1000) : null,
          elapsedSeconds: state.session && state.session.startMs
            ? Math.floor((now - state.session.startMs) / 1000)
            : null,
          stats: computeStats(state.history),
          sessionMaxSeconds: SESSION_MAX_SECONDS
        };
      })();

    case 'openIntra':
      return openIntra();

    case 'resetStats':
      return (async () => {
        const state = await getState();
        state.history = [];
        await setState(state);
        return { ok: true };
      })();

    case 'testNotification':
      return api.notifications.create(NOTIFICATION_ID + '-test', {
        type: 'basic',
        iconUrl: ICON_URL,
        title: '✅ Test',
        message: 'Les notifications fonctionnent.'
      }).then(() => ({ ok: true }));

    default:
      return undefined;
  }
});

// Filet de sécurité : même sans onglet intra actif, on continue de compter.
api.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    evaluate(Date.now()).catch((err) => console.warn('[42 Reminder/bg] alarm:', err));
  }
});

api.notifications.onClicked.addListener(() => {
  openIntra().catch((err) => console.warn('[42 Reminder/bg] openIntra:', err));
  api.notifications.clear(NOTIFICATION_ID).catch(() => {});
});

api.runtime.onInstalled.addListener(async () => {
  const stored = await api.storage.local.get(['settings', 'alertHours']);
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});

  // Migrations : v1 stockait `alertHours`, v2 un seuil de présence
  // (`alertSeconds`). Les deux se convertissent en préavis avant l'échéance.
  const legacySeconds = stored.settings && stored.settings.alertSeconds
    ? Number(stored.settings.alertSeconds)
    : Number(stored.alertHours) * 3600;
  if (!settings.warnBeforeSeconds && Number.isFinite(legacySeconds) && legacySeconds > 0) {
    settings.warnBeforeSeconds = clampWarnBefore(SESSION_MAX_SECONDS - legacySeconds, false);
  }
  delete settings.alertSeconds;

  await api.storage.local.set({ settings });
});
