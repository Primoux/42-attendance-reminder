/*
 * content.js - observe la page attendance et rapporte l'état de badge au
 * background.
 * Aucune décision de notification ici : le background est seul maître (l'état
 * doit survivre aux rechargements de page et aux onglets multiples).
 */

const api = typeof browser !== 'undefined' ? browser : chrome;

const TICK_MS = 15000;
// `detect()` fait trois parcours complets du DOM (échéance, compte à rebours,
// candidats) : la page rafraîchissant son compte à rebours toute seule, un
// debounce court reviendrait à les refaire en boucle pour rien.
const MUTATION_DEBOUNCE_MS = 5000;

let debug = DEFAULT_SETTINGS.debug;
let warnBeforeSeconds = DEFAULT_SETTINGS.warnBeforeSeconds;
// La page attendance ne se met pas à jour après un badge : seul son compte à
// rebours bouge. On la redemande donc au serveur, sans la recharger à l'écran.
let fresh = null; // { state, domState } - cf. pickState
let lastRefreshMs = Date.now(); // la page vient d'être chargée, son DOM est à jour
let refreshing = false;
let lastSignature = null;
let lastSentMs = 0;
let mutationTimer = null;

function log(...args) {
  if (debug) console.log('[42 Reminder]', ...args);
}

function warn(...args) {
  console.warn('[42 Reminder]', ...args);
}

function applySettings(settings) {
  if (!settings) return;
  if (typeof settings.debug === 'boolean') debug = settings.debug;
  if (Number.isFinite(settings.warnBeforeSeconds)) warnBeforeSeconds = settings.warnBeforeSeconds;
}

async function loadSettings() {
  try {
    const stored = await api.storage.local.get('settings');
    applySettings(stored && stored.settings);
  } catch (err) {
    warn('lecture des settings impossible:', err);
  }
}

function describe(state) {
  const src = `source: ${state.source || 'aucune'}`;
  if (!state.startMs && !state.expiryMs) return `${state.status} (${src})`;
  const parts = [];
  if (state.startMs) {
    parts.push(`depuis ${formatClock(state.startMs)} (${formatDuration((Date.now() - state.startMs) / 1000)})`);
  }
  if (state.expiryMs) {
    parts.push(`expire à ${formatClock(state.expiryMs)} (reste ${formatDuration((state.expiryMs - Date.now()) / 1000)})`);
  }
  return `${state.status} ${parts.join(', ')} [${src}]`;
}

/**
 * Relit la page côté serveur. Un échec (réseau, session 42 expirée, page de
 * login) ne change rien : on garde ce qu'on savait.
 */
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  lastRefreshMs = Date.now();
  try {
    const response = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) {
      log('[fetch] réponse', response.status, ': relecture ignorée');
      return;
    }
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const now = Date.now();
    const state = detectRemote(doc, now);
    if (state.status === STATUS.UNKNOWN) {
      log('[fetch] rien de lisible dans la réponse : relecture ignorée');
      return;
    }
    state.source = `fetch:${state.source || 'aucune'}`;
    const domState = detect(document, now);
    // Tant que le serveur confirme ce que la page affiche, la page reste la
    // meilleure source : elle seule a les heures de présence en heure locale.
    if (sameBadgeState(state, domState)) {
      log('[fetch] le serveur confirme la page');
      fresh = null;
    } else {
      fresh = { state, domState };
    }
    tick('fetch');
  } catch (err) {
    log('[fetch] relecture en échec:', err.message || err);
  } finally {
    refreshing = false;
  }
}

function tick(reason) {
  const now = Date.now();
  let state;
  try {
    state = pickState(detect(document, now), fresh);
  } catch (err) {
    warn('détection en échec:', err);
    return;
  }

  if (now - lastRefreshMs >= refreshDelayMs(state, warnBeforeSeconds, now)) refresh();

  // signature = ce qui compte pour le background ; évite le spam de messages
  const signature = `${state.status}|${state.startMs || 0}|${state.expiryMs || 0}`;
  const changed = signature !== lastSignature;
  lastSignature = signature;

  if (changed) log(`[${reason}] changement ->`, describe(state), '| brut:', state.raw);
  else log(`[${reason}]`, describe(state));

  if (state.status === STATUS.UNKNOWN && changed) {
    warn('aucun marqueur "On Site" trouvé sur cette page. URL:', location.pathname);
  }

  // Le background ne s'intéresse qu'aux changements ; le reste n'est qu'un
  // battement de cœur pour `lastSeenMs`. Sans ce filtre, chaque mutation
  // déclenchait un message, donc un réveil de la page background et une
  // écriture dans storage.local — en continu, sur un onglet ouvert la journée.
  if (!changed && now - lastSentMs < TICK_MS - 1000) return;
  lastSentMs = now;

  try {
    const sending = api.runtime.sendMessage({
      action: 'badgeState',
      state: {
        status: state.status,
        startMs: state.startMs,
        expiryMs: state.expiryMs,
        source: state.source,
        raw: state.raw
      },
      url: location.href,
      at: now
    });
    if (sending && typeof sending.catch === 'function') {
      sending.catch((err) => warn('envoi au background impossible:', err.message || err));
    }
  } catch (err) {
    // arrive quand l'extension est rechargée pendant que la page vit encore
    warn('contexte de l\'extension invalidé, arrêt du monitoring:', err.message || err);
    clearInterval(intervalId);
  }
}

function scheduleFromMutation() {
  if (mutationTimer) return;
  mutationTimer = setTimeout(() => {
    mutationTimer = null;
    tick('dom');
  }, MUTATION_DEBOUNCE_MS);
}

const intervalId = setInterval(() => tick('interval'), TICK_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') tick('visible');
});

// La page attendance recharge des morceaux en ajax : on réagit aux mutations
// plutôt que d'attendre le prochain tick.
try {
  new MutationObserver(scheduleFromMutation).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
} catch (err) {
  warn('MutationObserver indisponible:', err);
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
});

// Log inconditionnel : c'est le seul moyen de distinguer "content script pas
// injecté" (aucune ligne) de "injecté mais rien trouvé" (statut unknown).
console.log('[42 Reminder] content script actif sur', location.href);

loadSettings().then(() => tick('init'));
