const api = typeof browser !== 'undefined' ? browser : chrome;

const el = (id) => document.getElementById(id);
const fields = {
  minutes: el('minutes'), repeat: el('repeat'),
  seconds: el('seconds'), secondsRow: el('secondsRow'),
  testMode: el('testMode'), debug: el('debug')
};

let refreshTimer = null;

function showMessage(text, isError) {
  const msg = el('msg');
  msg.textContent = text;
  msg.classList.toggle('error', Boolean(isError));
  setTimeout(() => { msg.textContent = ''; msg.classList.remove('error'); }, 2500);
}

function applySettings(settings) {
  const total = settings.warnBeforeSeconds;
  fields.minutes.value = Math.max(1, Math.round(total / 60));
  fields.repeat.value = Math.round(settings.repeatSeconds / 60);
  fields.seconds.value = total;
  fields.testMode.checked = Boolean(settings.testMode);
  fields.debug.checked = Boolean(settings.debug);
  fields.secondsRow.style.display = settings.testMode ? '' : 'none';
}

/**
 * Préavis saisi, en secondes. Le champ "secondes" du mode test ne prime que
 * s'il est réellement renseigné : vide, il valait 0 et retombait sur le
 * minimum (5 s), écrasant silencieusement le champ minutes.
 */
function readWarnBeforeSeconds(testMode) {
  if (testMode) {
    const seconds = Number(fields.seconds.value);
    if (fields.seconds.value !== '' && Number.isFinite(seconds) && seconds >= 1) return seconds;
  }
  const minutes = Number(fields.minutes.value);
  if (fields.minutes.value !== '' && Number.isFinite(minutes) && minutes > 0) return minutes * 60;
  return DEFAULT_SETTINGS.warnBeforeSeconds;
}

function readSettings() {
  const testMode = fields.testMode.checked;
  const raw = readWarnBeforeSeconds(testMode);
  const warnBeforeSeconds = clampWarnBefore(raw, testMode);
  const repeatMinutes = Math.min(Math.max(Number(fields.repeat.value) || 15, 1), 120);
  return {
    warnBeforeSeconds,
    repeatSeconds: testMode ? Math.min(repeatMinutes * 60, warnBeforeSeconds) : repeatMinutes * 60,
    testMode,
    debug: fields.debug.checked,
    _clamped: warnBeforeSeconds !== raw
  };
}

function renderStatus(info) {
  const dot = el('dot');
  const bar = el('barFill');
  const elapsedNode = el('elapsed');
  const statusNode = el('statusText');

  dot.className = 'dot';
  bar.className = '';

  if (!info.expiryMs) {
    el('logtimeInfo').textContent = '';
    elapsedNode.textContent = '—';
    bar.style.width = '0';
    statusNode.textContent = info.lastStatus === STATUS.OFF_SITE
      ? 'Pas badgé (ou session terminée).'
      : 'Aucune session détectée.';
    el('openIntra').hidden = false;
    return;
  }
  el('openIntra').hidden = true;

  const remaining = info.remainingSeconds;
  el('logtimeInfo').textContent = `expire à ${formatClock(info.expiryMs)}`;

  // La barre se remplit à mesure que le temps restant fond.
  const consumed = Math.min(Math.max(1 - remaining / info.sessionMaxSeconds, 0), 1);
  const level = remaining <= 300 ? 'danger'
    : remaining <= info.settings.warnBeforeSeconds ? 'warn'
    : 'on';

  dot.classList.add(level);
  if (level !== 'on') bar.classList.add(level); // classList.add('') lève une exception
  bar.style.width = `${(consumed * 100).toFixed(1)}%`;
  elapsedNode.textContent = remaining > 0 ? formatDuration(remaining) : '00s';

  const label = info.session && info.session.status === STATUS.ON_SITE_UNSAVED
    ? 'On Site (unsaved)' : 'On Site';
  const since = info.session && info.session.startMs
    ? ` depuis ${formatClock(info.session.startMs)}` : '';
  statusNode.textContent = remaining > 0
    ? `${label}${since} · ${formatDuration(remaining)} restantes`
    : `${label}${since} · échéance dépassée`;
}

async function refresh(applyInputs) {
  try {
    const info = await api.runtime.sendMessage({ action: 'getStatus' });
    if (!info) return;
    if (applyInputs) applySettings(info.settings);
    renderStatus(info);
  } catch (err) {
    // Le popup est relu à chaque ouverture, pas le background : en dev, après
    // une modif, il faut recharger l'extension pour que les deux concordent.
    const detail = err && err.message ? err.message : String(err);
    el('statusText').textContent = `Extension à recharger. [${detail}]`;
    console.warn('[42 Reminder/popup]', err);
  }
}

el('save').addEventListener('click', async () => {
  const settings = readSettings();
  const clamped = settings._clamped;
  delete settings._clamped;
  await api.storage.local.set({ settings });
  applySettings(settings);
  showMessage(clamped
    ? `⚠️ Ajusté à ${formatDuration(settings.warnBeforeSeconds)} avant l'échéance`
    : `✅ Alerte ${formatDuration(settings.warnBeforeSeconds)} avant l'échéance`);
  refresh(false);
});

el('test').addEventListener('click', async () => {
  try {
    await api.runtime.sendMessage({ action: 'testNotification' });
    showMessage('✅ Notification envoyée');
  } catch (err) {
    showMessage('❌ Notifications bloquées', true);
  }
});

el('openIntra').addEventListener('click', async () => {
  try {
    await api.runtime.sendMessage({ action: 'openIntra' });
    window.close();
  } catch (err) {
    showMessage('❌ Ouverture impossible', true);
    console.warn('[42 Reminder/popup]', err);
  }
});

fields.testMode.addEventListener('change', () => {
  fields.secondsRow.style.display = fields.testMode.checked ? '' : 'none';
  if (fields.testMode.checked) fields.seconds.value = readWarnBeforeSeconds(false);
});

// Tant que l'utilisateur édite les minutes, le champ secondes suit : sinon les
// deux champs divergent et c'est le moins visible des deux qui gagne.
fields.minutes.addEventListener('input', () => {
  if (fields.testMode.checked && fields.minutes.value !== '') {
    fields.seconds.value = Number(fields.minutes.value) * 60;
  }
});

refresh(true);
refreshTimer = setInterval(() => refresh(false), 1000);
window.addEventListener('unload', () => clearInterval(refreshTimer));
