/*
 * parser.js - logique pure, partagée entre content.js, background.js et les tests.
 * Aucune dépendance, aucun accès direct à `document` global (on passe toujours
 * une racine en argument) => testable dans Node avec un faux DOM.
 */

// attendance.42lyon.fr fixe l'échéance à 4h après le dernier clock-in
// (badge à 10:31 -> "expire à 14:31"). Sert à déduire le début quand seule
// l'échéance est affichée.
const SESSION_MAX_SECONDS = 4 * 3600;

const STATUS = {
  ON_SITE: 'on_site',
  ON_SITE_UNSAVED: 'on_site_unsaved',
  OFF_SITE: 'off_site',
  UNKNOWN: 'unknown'
};

const DEFAULT_SETTINGS = {
  warnBeforeSeconds: 30 * 60, // prévenir 30 min avant l'échéance annoncée
  repeatSeconds: 15 * 60,     // relance toutes les 15 min tant qu'on est badgé
  testMode: false,            // seuils en secondes ; réglable via storage.local
  debug: false                // logs console détaillés ; idem
};

// "On Site Unsaved", "On site (unsaved)", "ON-SITE - UNSAVED"...
const RE_UNSAVED = /on[\s-]*site[\s(:\[-]*unsaved/i;
const RE_ON_SITE = /on[\s-]*site/i;
const RE_OFF_SITE = /(off[\s-]*site|not on site|logged out|no location|unavailable)/i;
// 10:31, 10:31:05, 10h31 - refuse 42:00 et les numéros de version
const RE_TIME = /(?:^|[^\d:h])([01]?\d|2[0-3])[:h]([0-5]\d)(?:[:h]([0-5]\d))?(?![\d:h])/g;
const RE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
// attendance.42lyon.fr affiche lui-même l'échéance et le compte à rebours :
// "LA SESSION EXPIRE À 14:31" et "03h08m". C'est la source la plus fiable.
const RE_EXPIRY = /session\s+expir\w*\s*(?:à|a|at)?\s*(\d{1,2})[:h]([0-5]\d)/i;
const RE_COUNTDOWN = /\b(\d{1,2})\s*h\s*([0-5]\d)\s*m\b/i;

function normalize(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/** Toutes les heures présentes dans un texte, dans l'ordre d'apparition. */
function findTimes(text) {
  const out = [];
  const re = new RegExp(RE_TIME.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      hours: parseInt(m[1], 10),
      minutes: parseInt(m[2], 10),
      seconds: m[3] ? parseInt(m[3], 10) : 0,
      raw: m[0].trim()
    });
    // le lookbehind est simulé par un groupe consommé : on recule d'un cran
    re.lastIndex = Math.max(re.lastIndex - 1, m.index + 1);
  }
  return out;
}

/**
 * Transforme une heure murale ("10:31") en timestamp absolu.
 * Si l'heure est dans le futur (à 5 min près, pour absorber une horloge
 * légèrement désynchro), c'est qu'elle vient de la veille.
 */
function resolveClockTime(time, nowMs, direction) {
  if (!time) return null;
  const d = new Date(nowMs);
  d.setHours(time.hours, time.minutes, time.seconds || 0, 0);
  if (direction === 'future') {
    // une échéance déjà passée depuis > 5 min appartient à demain
    if (d.getTime() < nowMs - 5 * 60 * 1000) d.setDate(d.getDate() + 1);
  } else if (d.getTime() > nowMs + 5 * 60 * 1000) {
    d.setDate(d.getDate() - 1);
  }
  return d.getTime();
}

function parseIso(value) {
  const raw = normalize(value);
  if (!RE_ISO.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function readIsoAttr(el) {
  if (!el || typeof el.getAttribute !== 'function') return null;
  for (const attr of ['datetime', 'data-begin-at', 'data-start', 'title']) {
    const ms = parseIso(el.getAttribute(attr));
    if (ms !== null) return ms;
  }
  if (typeof el.querySelector === 'function') {
    const child = el.querySelector('[datetime]');
    if (child && child !== el) return parseIso(child.getAttribute('datetime'));
  }
  return null;
}

/**
 * Ramasse les éléments du DOM susceptibles de porter l'info de badge.
 * On ignore les gros conteneurs (<html>, <body>, ...) via la limite de
 * longueur : c'est ce qui évite de matcher n'importe quelle heure de la page.
 */
function collectCandidates(root, maxTextLength = 400) {
  const out = [];
  if (!root || typeof root.querySelectorAll !== 'function') return out;
  for (const el of root.querySelectorAll('*')) {
    const text = normalize(el.textContent);
    if (!text || text.length > maxTextLength) continue;
    if (!RE_ON_SITE.test(text) && !RE_OFF_SITE.test(text)) continue;
    out.push({ text, iso: readIsoAttr(el) });
  }
  return out;
}

/**
 * Une ligne dont l'une des heures colle à maintenant est la ligne en cours :
 * sur attendance, la borne de droite suit l'horloge ("10:31 → 11:22").
 * On teste toutes les heures et pas seulement la dernière, parce que la ligne
 * se termine souvent par une durée ("00:51") qui se lit comme une heure.
 */
function hasLiveTime(times, nowMs) {
  return times.some((t) => Math.abs(nowMs - resolveClockTime(t, nowMs)) <= 3 * 60 * 1000);
}

function scoreCandidate(c, nowMs) {
  // plus le score est haut, plus le candidat est fiable
  let score = 0;
  if (c.iso !== null && c.iso !== undefined) score += 1000; // timestamp absolu = idéal
  const times = findTimes(c.text);
  if (hasLiveTime(times, nowMs)) score += 400; // la ligne en cours prime sur les archives
  if (times.length === 1) score += 200;        // "On Site 10:31" -> session ouverte
  else if (times.length >= 2) score -= 100;    // "10:31 - 14:00" -> session fermée
  if (RE_ON_SITE.test(c.text)) score += 50;
  score += Math.max(0, 120 - c.text.length);   // le plus spécifique gagne
  return score;
}

/**
 * Décide de l'état courant à partir des candidats.
 * -> { status, startMs, source, raw }
 */
function analyze(candidates, nowMs) {
  const onSite = candidates.filter((c) => RE_ON_SITE.test(c.text));

  if (onSite.length === 0) {
    const off = candidates.some((c) => RE_OFF_SITE.test(c.text));
    return { status: off ? STATUS.OFF_SITE : STATUS.UNKNOWN, startMs: null, source: null, raw: null };
  }

  const best = onSite.slice().sort((a, b) => scoreCandidate(b, nowMs) - scoreCandidate(a, nowMs))[0];
  const status = RE_UNSAVED.test(best.text) ? STATUS.ON_SITE_UNSAVED : STATUS.ON_SITE;

  if (best.iso !== null && best.iso !== undefined) {
    return { status, startMs: best.iso, source: 'iso', raw: best.text };
  }

  const times = findTimes(best.text);
  if (times.length === 0) {
    // "On Site" sans heure : on sait qu'on est badgé, pas depuis quand
    return { status, startMs: null, source: 'no-time', raw: best.text };
  }
  if (times.length >= 2) {
    if (hasLiveTime(times, nowMs)) {
      return { status, startMs: resolveClockTime(times[0], nowMs), source: 'live-range', raw: best.text };
    }
    // intervalle entièrement dans le passé => la session est terminée
    return { status: STATUS.OFF_SITE, startMs: null, source: 'closed-range', raw: best.text };
  }

  const startMs = resolveClockTime(times[0], nowMs);
  const elapsed = (nowMs - startMs) / 1000;
  if (elapsed < 0 || elapsed > 24 * 3600) {
    return { status, startMs: null, source: 'out-of-range', raw: best.text };
  }
  return { status, startMs, source: 'clock', raw: best.text };
}

/** Texte le plus court du DOM qui matche `re` (le plus spécifique). */
function findShortestMatch(root, re, maxTextLength = 160) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  let best = null;
  for (const el of root.querySelectorAll('*')) {
    const text = normalize(el.textContent);
    if (!text || text.length > maxTextLength || !re.test(text)) continue;
    if (!best || text.length < best.length) best = text;
  }
  return best;
}

/**
 * Lit l'échéance annoncée par la page d'attendance, soit en absolu
 * ("LA SESSION EXPIRE À 14:31"), soit via le compte à rebours ("03h08m").
 */
function detectExpiry(root, nowMs) {
  const absolute = findShortestMatch(root, RE_EXPIRY);
  if (absolute) {
    const m = RE_EXPIRY.exec(absolute);
    const expiryMs = resolveClockTime(
      { hours: parseInt(m[1], 10), minutes: parseInt(m[2], 10) }, nowMs, 'future'
    );
    return { expiryMs, source: 'expiry', raw: absolute };
  }
  const countdown = findShortestMatch(root, RE_COUNTDOWN, 40);
  if (countdown) {
    const m = RE_COUNTDOWN.exec(countdown);
    const remainingMs = (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60) * 1000;
    return { expiryMs: nowMs + remainingMs, source: 'countdown', raw: countdown };
  }
  return null;
}

/**
 * Point d'entrée DOM.
 * -> { status, startMs, expiryMs, source, raw }
 *
 * L'échéance de la page d'attendance prime : elle est exacte, alors que
 * l'heure de début doit être déduite.
 */
function detect(root, nowMs) {
  const expiry = detectExpiry(root, nowMs);
  const fromDom = analyze(collectCandidates(root), nowMs);

  if (expiry && expiry.expiryMs) {
    return {
      status: isOnSite(fromDom.status) ? fromDom.status : STATUS.ON_SITE,
      // le début n'est pas affiché : on le déduit de l'échéance, sauf si le DOM
      // nous a donné une heure de badge réelle
      startMs: fromDom.startMs || expiry.expiryMs - SESSION_MAX_SECONDS * 1000,
      expiryMs: expiry.expiryMs,
      source: fromDom.startMs ? `${fromDom.source}+${expiry.source}` : expiry.source,
      raw: expiry.raw
    };
  }

  return Object.assign({}, fromDom, {
    expiryMs: fromDom.startMs ? fromDom.startMs + SESSION_MAX_SECONDS * 1000 : null
  });
}

function isOnSite(status) {
  return status === STATUS.ON_SITE || status === STATUS.ON_SITE_UNSAVED;
}

/**
 * Échéance de la session. La page l'affiche directement ; sinon on la déduit
 * de l'heure de badge (+4h), ce qui reste vrai sur les pages sans compte à rebours.
 */
function sessionExpiry(session) {
  if (!session) return null;
  if (session.expiryMs) return session.expiryMs;
  if (session.startMs) return session.startMs + SESSION_MAX_SECONDS * 1000;
  return null;
}

/**
 * Anti-spam : décide s'il faut notifier maintenant, en fonction du temps
 * restant avant l'échéance.
 * session : { startMs?, expiryMs?, notifiedCount, lastNotifiedMs }
 * -> { notify, kind, remainingSeconds, elapsedSeconds }
 */
function decideNotification(session, settings, nowMs) {
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const expiry = sessionExpiry(session);
  if (!expiry) return { notify: false, kind: null, remainingSeconds: null, elapsedSeconds: null };

  const remainingSeconds = Math.round((expiry - nowMs) / 1000);
  const elapsedSeconds = session.startMs ? Math.floor((nowMs - session.startMs) / 1000) : null;
  const quiet = { notify: false, kind: null, remainingSeconds, elapsedSeconds };
  const result = (kind) => ({ notify: true, kind, remainingSeconds, elapsedSeconds });
  const sinceLast = (nowMs - (session.lastNotifiedMs || 0)) / 1000;

  if (remainingSeconds <= 0) return quiet; // échéance passée, plus rien à sauver

  // Dernière ligne droite : au plus une notification par minute.
  // Le min() évite d'écraser un seuil volontairement plus court (mode test).
  if (remainingSeconds <= Math.min(300, s.warnBeforeSeconds)) {
    return sinceLast >= 60 ? result('logtime_lost_soon') : quiet;
  }

  if (remainingSeconds > s.warnBeforeSeconds) return quiet;
  if (!session.notifiedCount) return result('threshold');
  if (sinceLast >= s.repeatSeconds) return result('repeat');
  return quiet;
}

/** Borne le préavis saisi par l'utilisateur. En testMode on autorise 5 s. */
function clampWarnBefore(seconds, testMode) {
  const min = testMode ? 5 : 60;
  const max = SESSION_MAX_SECONDS - 60; // un préavis plus long que la session n'a pas de sens
  const n = Number(seconds);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.warnBeforeSeconds;
  return Math.min(Math.max(Math.round(n), min), max);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SESSION_MAX_SECONDS, STATUS, DEFAULT_SETTINGS,
    normalize, findTimes, resolveClockTime, parseIso, readIsoAttr,
    collectCandidates, analyze, detect, detectExpiry, findShortestMatch, isOnSite, sessionExpiry,
    decideNotification, clampWarnBefore, formatDuration, formatClock
  };
}
