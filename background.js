/*
 * background.js - source de vérité de l'état de session et des notifications.
 * En MV3 la page background est non-persistante : tout l'état vit dans
 * storage.local, jamais en mémoire.
 */

const api = typeof browser !== 'undefined' ? browser : chrome;

const ALARM_NAME = '42-reminder-tick';
const NOTIFICATION_ID = '42-reminder';
// PNG et pas SVG : seuls les PNG sont empaquetés (cf. le script `build`).
// Firefox n'échoue pas sur une iconUrl absente, il retombe juste sur l'icône
// par défaut - d'où un SVG manquant passé inaperçu jusqu'en 1.0.0.
const ICON_URL = api.runtime.getURL('icon-48.png');
const ATTENDANCE_URL = `https://${ATTENDANCE_HOST}/me`;

// Un onglet attendance parle toutes les 15 s et relit la page lui-même : tant
// qu'il s'est manifesté depuis moins longtemps que ça, le background s'abstient.
const TAB_SILENCE_MS = 2 * 60 * 1000;
// Sans session à surveiller, il ne s'agit que de repérer un premier badge :
// inutile de solliciter le serveur plus souvent.
const IDLE_REFRESH_MS = 15 * 60 * 1000;

const EMPTY_STATE = {
  session: null, // { startMs, expiryMs, status, lastSeenMs, notifiedCount, lastNotifiedMs }
  lastStatus: STATUS.UNKNOWN,
  lastTabReportMs: 0, // dernier message d'un onglet attendance
  lastRemoteMs: 0,    // dernière relecture du serveur par le background
  // Dernier échec de notification, remonté au popup : sans ça une extension qui
  // n'a plus le droit de notifier a l'air de fonctionner parfaitement.
  notifyError: null // { message, at }
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

/** `notifications.clear` ne renvoie pas toujours une promesse selon le moteur. */
async function clearNotification() {
  try {
    await api.notifications.clear(NOTIFICATION_ID);
  } catch (err) {
    /* rien à nettoyer */
  }
}

/**
 * Efface la session. Ne touche pas à la notification affichée : après une
 * alerte d'échéance dépassée, c'est justement elle qu'on veut laisser à l'écran.
 */
async function endSession(state, settings, reason) {
  log(settings, 'session terminée :', reason);
  state.session = null;
  await setState(state);
}

async function handleBadgeState(message) {
  const settings = await getSettings();
  const state = await getState();
  const incoming = message.state || {};
  const now = message.at || Date.now();

  await applyBadgeState(state, settings, incoming, now);
  state.lastStatus = incoming.status || STATUS.UNKNOWN;
  state.lastTabReportMs = now;
  await setState(state);
  await evaluate(now, settings, state);
}

/**
 * Applique à `state` un état de badge, qu'il vienne d'un onglet ou d'une
 * relecture du serveur. Ne persiste rien : l'appelant enregistre.
 */
async function applyBadgeState(state, settings, incoming, now) {
  if (isOnSite(incoming.status) && (incoming.startMs || incoming.expiryMs)) {
    // Une session finie ne doit pas absorber le badge suivant : on garderait
    // son startMs et le popup afficherait la présence de la veille.
    const current = isSessionOver(state.session, now) ? null : state.session;
    if (!current) {
      const fresh = {
        startMs: incoming.startMs || null,
        expiryMs: incoming.expiryMs || null,
        status: incoming.status,
        lastSeenMs: now,
        notifiedCount: 0,
        lastNotifiedMs: 0
      };
      // La page peut annoncer une échéance déjà passée (badgé depuis plus de 4 h
      // sans rebadger). Ouvrir une session pour la purger dans la foulée ferait
      // recréer-notifier-effacer à chaque tick du content script, soit toutes
      // les 15 s : on n'ouvre que ce qu'il y a encore à surveiller.
      if (isSessionOver(fresh, now)) {
        log(settings, 'échéance déjà passée à la découverte, aucune session ouverte');
      } else {
        state.session = fresh;
        log(settings, 'nouvelle session, échéance', formatClock(sessionExpiry(fresh)));
        // l'alerte de la session précédente ne concerne plus celle-ci
        await clearNotification();
      }
    } else {
      // Rebadger repousse l'échéance : c'est un nouveau cycle d'alerte, mais la
      // même présence — on garde le début le plus ancien et l'historique.
      // La comparaison tolère le bruit : une échéance déduite d'un compte à
      // rebours bouge de quelques secondes à chaque lecture, et la prendre pour
      // un rebadge remettrait `notifiedCount` à zéro toutes les 15 s — donc une
      // notification « threshold » toutes les 15 s dans la fenêtre d'alerte.
      if (isNewDeadline(current.expiryMs, incoming.expiryMs)) {
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
      await endSession(state, settings, 'badge out détecté');
      await clearNotification();
    }
  }
  // STATUS.UNKNOWN : la page ne dit rien (mauvaise page, DOM changé) -> on garde
  // la session telle quelle plutôt que de perdre le timer.
}

/**
 * Sans onglet attendance, personne ne dit qu'on a rebadgé ou badgé out : le
 * background redemande alors la page au serveur. Firefox y joint la session 42
 * de lui-même, la permission d'hôte suffit.
 * -> l'état lu, ou null s'il n'y a rien à en tirer (pas l'heure, pas connecté,
 * réseau coupé) : on garde alors ce qu'on savait.
 */
async function readServer(now, settings) {
  // une page background a un DOM ; un service worker n'en aurait pas
  if (typeof fetch !== 'function' || typeof DOMParser === 'undefined') return null;

  const state = await getState();
  if (now - (state.lastTabReportMs || 0) < TAB_SILENCE_MS) return null;
  const tracked = isSessionOver(state.session, now) ? null : state.session;
  const delay = tracked
    ? refreshDelayMs({ expiryMs: sessionExpiry(tracked) }, settings.warnBeforeSeconds, now)
    : IDLE_REFRESH_MS;
  if (now - (state.lastRemoteMs || 0) < delay) return null;

  // noté avant la requête : un serveur en panne ne doit pas être relancé à
  // chaque minute
  state.lastRemoteMs = now;
  await setState(state);

  try {
    const response = await fetch(ATTENDANCE_URL, { credentials: 'include', cache: 'no-store' });
    // redirigé hors d'attendance : c'est la page de connexion
    if (!response.ok || new URL(response.url).host !== ATTENDANCE_HOST) {
      log(settings, 'relecture ignorée, réponse', response.status, response.url);
      return null;
    }
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const remote = detectRemote(doc, now);
    if (remote.status === STATUS.UNKNOWN) {
      log(settings, 'relecture ignorée, rien de lisible dans la réponse');
      return null;
    }
    log(settings, 'relecture du serveur :', remote.status,
      remote.expiryMs ? `échéance ${formatClock(remote.expiryMs)}` : '');
    return remote;
  } catch (err) {
    log(settings, 'relecture en échec :', (err && err.message) || err);
    return null;
  }
}

/** Le battement d'une minute : relecture éventuelle, puis décision. */
async function onTick(now) {
  const settings = await getSettings();
  const remote = await readServer(now, settings);
  // relu après la requête : un onglet a pu parler entre-temps
  const state = await getState();
  if (remote) {
    await applyBadgeState(state, settings, remote, now);
    state.lastStatus = remote.status;
    await setState(state);
  }
  await evaluate(now, settings, state);
}

/**
 * Temps restant sur l'icône : la seule info visible sans ouvrir le popup ni
 * attendre une notification. Rafraîchi à chaque réveil du background, donc au
 * moins une fois par minute grâce à l'alarme.
 */
async function renderBadge(state, now, settings) {
  const action = api.action || api.browserAction;
  if (!action || typeof action.setBadgeText !== 'function') return;
  const expiry = sessionExpiry(state.session);
  const remaining = expiry ? Math.round((expiry - now) / 1000) : 0;
  const text = badgeText(remaining);
  try {
    await action.setBadgeText({ text });
    if (text && typeof action.setBadgeBackgroundColor === 'function') {
      await action.setBadgeBackgroundColor({
        color: badgeColor(remaining, settings.warnBeforeSeconds)
      });
    }
  } catch (err) {
    console.warn('[42 Reminder/bg] badge impossible:', err);
  }
}

async function evaluate(now, settings, preloadedState) {
  const s = settings || (await getSettings());
  const state = preloadedState || (await getState());
  try {
    await evaluateSession(now, s, state);
  } finally {
    // même si la décision a échoué, l'icône ne doit pas rester sur une valeur
    // périmée : c'est ce que l'utilisateur voit en permanence
    await renderBadge(state, now, s);
  }
}

async function evaluateSession(now, s, state) {
  if (!state.session) return;

  // Sans onglet attendance ouvert, l'alarme est le seul à pouvoir constater la
  // fin : personne ne viendra nous dire que la session est morte. On décide
  // avant de purger, sinon la dernière alerte serait avalée par le nettoyage.
  const over = isSessionOver(state.session, now);
  const decision = decideNotification(state.session, s, now);

  if (!decision.notify) {
    if (over) await endSession(state, s, 'échéance passée');
    return;
  }

  const remaining = formatDuration(decision.remainingSeconds);
  const expiresAt = formatClock(sessionExpiry(state.session));
  const presence = decision.elapsedSeconds === null
    ? ''
    : ` (${formatDuration(decision.elapsedSeconds)} sur place)`;

  let title = '⏰ Rebadge bientôt';
  let body = `Logtime lost dans ${remaining}, à ${expiresAt}.${presence}`;
  if (decision.kind === 'expired') {
    title = '💀 Logtime perdu';
    body = `L'échéance de ${expiresAt} est passée. Rebadge pour repartir.`;
  } else if (decision.kind === 'logtime_lost_soon') {
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
    state.notifyError = null;
  } catch (err) {
    console.warn('[42 Reminder/bg] notification impossible:', err);
    state.notifyError = { message: (err && err.message) || String(err), at: now };
    await setState(state);
    return;
  }

  state.session.notifiedCount = (state.session.notifiedCount || 0) + 1;
  state.session.lastNotifiedMs = now;
  if (decision.kind === 'expired') state.session.expiredNotified = true;
  await setState(state);
  log(s, `notification "${decision.kind}" envoyée (reste ${remaining})`);

  // La session finie n'est purgée qu'ici : sa dernière alerte est partie, et on
  // laisse volontairement la notification affichée à l'écran.
  if (over) await endSession(state, s, 'échéance passée, dernière alerte envoyée');
}

/**
 * Ouvre l'attendance. Si un onglet attendance existe déjà, on l'active *et
 * on le recharge* : après un rechargement de l'extension, les onglets déjà
 * ouverts n'ont plus de content script et ne rapportent donc plus rien.
 */
/**
 * Onglets attendance ouverts. Filtrée par URL sur un hôte autorisé, la requête
 * n'a pas besoin de la permission "tabs".
 */
async function attendanceTabs() {
  try {
    return (await api.tabs.query({ url: `*://${ATTENDANCE_HOST}/*` })) || [];
  } catch (err) {
    console.warn('[42 Reminder/bg] tabs.query indisponible:', err);
    return [];
  }
}

async function openAttendance() {
  const tabs = await attendanceTabs();
  if (tabs.length) {
    try {
      await api.tabs.update(tabs[0].id, { active: true });
      await api.tabs.reload(tabs[0].id);
      return { ok: true, reused: true };
    } catch (err) {
      console.warn('[42 Reminder/bg] onglet attendance injoignable:', err);
    }
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
        const [settings, state, tabs] = await Promise.all([
          getSettings(), getState(), attendanceTabs()
        ]);
        const now = Date.now();
        // Le popup peut s'ouvrir avant le tick d'alarme qui purgera la session
        // finie : ne pas l'afficher comme si elle courait encore.
        const session = isSessionOver(state.session, now) ? null : state.session;
        const expiryMs = sessionExpiry(session);
        return {
          settings,
          session,
          lastStatus: state.lastStatus,
          notifyError: state.notifyError || null,
          // Distingue « aucun onglet attendance » de « onglet ouvert mais page
          // illisible » : seul le second signale un DOM qui a changé.
          attendanceTabOpen: tabs.length > 0,
          expiryMs,
          remainingSeconds: expiryMs ? Math.round((expiryMs - now) / 1000) : null,
          elapsedSeconds: session && session.startMs
            ? Math.floor((now - session.startMs) / 1000)
            : null,
          sessionMaxSeconds: SESSION_MAX_SECONDS
        };
      })();

    case 'openAttendance':
      return openAttendance();

    default:
      return undefined;
  }
});

// Filet de sécurité : même sans onglet attendance actif, on continue de compter.
// Ce top-level rejoue à chaque réveil de la page background (donc à chaque
// message du content script, soit toutes les 15 s) et `alarms.create` remplace
// l'alarme de même nom : la recréer à l'aveugle remettrait le compte à une
// minute à zéro sans arrêt, et l'alarme ne sonnerait jamais.
/**
 * `alarms.get` renvoie une promesse sur `browser.*` mais rien du tout sur un
 * moteur à callbacks : `await` donnerait alors `undefined` sans lever, et on
 * recréerait l'alarme à chaque réveil — précisément le bug qu'on évite ici.
 */
function getAlarm(name) {
  const maybe = api.alarms.get(name);
  if (maybe && typeof maybe.then === 'function') return maybe;
  return new Promise((resolve) => api.alarms.get(name, resolve));
}

async function ensureAlarm() {
  try {
    if (await getAlarm(ALARM_NAME)) return;
  } catch (err) {
    // alarms.get indisponible : mieux vaut une alarme recréée que pas d'alarme
  }
  api.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

ensureAlarm().catch((err) => console.warn('[42 Reminder/bg] ensureAlarm:', err));

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    onTick(Date.now()).catch((err) => console.warn('[42 Reminder/bg] alarm:', err));
  }
});

api.notifications.onClicked.addListener(() => {
  openAttendance().catch((err) =>
    console.warn('[42 Reminder/bg] openAttendance:', err));
  clearNotification();
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
