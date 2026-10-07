const api = typeof browser !== 'undefined' ? browser : chrome;

const el = (id) => document.getElementById(id);
const fields = { minutes: el('minutes'), repeat: el('repeat') };

let refreshTimer = null;
// Les réglages sans champ dans le popup (debug, testMode) ne doivent pas être
// écrasés à l'enregistrement : storage.local.set remplace l'objet entier.
let currentSettings = null;

function showMessage(text, isError) {
  const msg = el('msg');
  msg.textContent = text;
  msg.classList.toggle('error', Boolean(isError));
  setTimeout(() => { msg.textContent = ''; msg.classList.remove('error'); }, 2500);
}

function applySettings(settings) {
  currentSettings = settings;
  // en mode test, le préavis se saisit en secondes
  const unit = warnBeforeUnitSeconds(settings.testMode);
  fields.minutes.value = Math.max(1, Math.round(settings.warnBeforeSeconds / unit));
  fields.minutes.max = (SESSION_MAX_SECONDS - 60) / unit;
  el('minutesUnit').textContent = settings.testMode ? 's' : 'min';
  fields.repeat.value = Math.round(settings.repeatSeconds / 60);
}

/** Un champ vide ne vaut pas 0 : on garde la valeur par défaut. */
function readSettings(previous) {
  const testMode = Boolean(previous && previous.testMode);
  const unit = warnBeforeUnitSeconds(testMode);
  const minutes = Number(fields.minutes.value);
  const raw = fields.minutes.value !== '' && Number.isFinite(minutes) && minutes > 0
    ? minutes * unit
    : DEFAULT_SETTINGS.warnBeforeSeconds;
  const warnBeforeSeconds = clampWarnBefore(raw, testMode);
  const repeatMinutes = Math.min(Math.max(Number(fields.repeat.value) || 15, 1), 120);
  return Object.assign({}, previous, {
    warnBeforeSeconds,
    repeatSeconds: repeatMinutes * 60,
    _clamped: warnBeforeSeconds !== raw
  });
}

/** Une notification refusée (notifications coupées au niveau de l'OS, par
 * exemple) ne se voit nulle part ailleurs que dans la console du background. */
function renderNotifyError(notifyError) {
  const node = el('notifyError');
  if (!notifyError) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = `⚠️ Notification impossible à ${formatClock(notifyError.at)} : ${notifyError.message}`;
}

function renderStatus(info) {
  const dot = el('dot');
  const bar = el('barFill');
  const elapsedNode = el('elapsed');
  const statusNode = el('statusText');

  dot.className = 'dot';
  bar.className = '';
  renderNotifyError(info.notifyError);
  el('permissionBox').hidden = info.hostPermission !== false;

  if (!info.expiryMs) {
    el('logtimeInfo').textContent = '';
    elapsedNode.textContent = '—';
    bar.style.width = '0';
    if (info.lastStatus === STATUS.OFF_SITE) {
      statusNode.textContent = 'Pas badgé (ou session terminée).';
    } else if (isOnSite(info.lastStatus)) {
      // badgé mais plus aucune échéance à surveiller : le logtime est déjà perdu
      statusNode.textContent = 'Badgé, échéance dépassée. Rebadge pour repartir.';
    } else if (info.attendanceTabOpen) {
      // un onglet rapporte, mais rien de lisible : pas connecté, ou DOM changé
      statusNode.textContent = 'Page attendance ouverte, mais aucun badge reconnu. '
        + 'Connecte-toi, ou le format de la page a changé.';
    } else {
      statusNode.textContent = `Aucune session détectée sur ${ATTENDANCE_HOST}.`;
    }
    el('openAttendance').hidden = false;
    return;
  }
  el('openAttendance').hidden = true;

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
  elapsedNode.textContent = formatDuration(remaining);

  const label = info.session && info.session.status === STATUS.ON_SITE_UNSAVED
    ? 'On Site (unsaved)' : 'On Site';
  const since = info.session && info.session.startMs
    ? ` depuis ${formatClock(info.session.startMs)}` : '';
  // `remaining` est forcément positif ici : le background masque les sessions
  // dont l'échéance est passée, elles sortent par la branche `!info.expiryMs`.
  statusNode.textContent = `${label}${since} · ${formatDuration(remaining)} restantes`;
}

async function refresh(applyInputs) {
  try {
    const info = await api.runtime.sendMessage({ action: 'getStatus' });
    if (!info) return;
    currentSettings = info.settings;
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
  const settings = readSettings(currentSettings);
  const clamped = settings._clamped;
  delete settings._clamped;
  await api.storage.local.set({ settings });
  applySettings(settings);
  showMessage(clamped
    ? `⚠️ Ajusté à ${formatDuration(settings.warnBeforeSeconds)} avant l'échéance`
    : `✅ Alerte ${formatDuration(settings.warnBeforeSeconds)} avant l'échéance`);
  refresh(false);
});

// `permissions.request` n'est accepté que dans le geste de l'utilisateur :
// l'appel part d'ici, pas du background.
el('grant').addEventListener('click', async () => {
  try {
    const granted = await api.permissions.request({ origins: [ATTENDANCE_ORIGIN] });
    if (!granted) showMessage('❌ Accès refusé', true);
    refresh(false);
  } catch (err) {
    showMessage('❌ Demande impossible', true);
    console.warn('[42 Reminder/popup]', err);
  }
});

el('openAttendance').addEventListener('click', async () => {
  try {
    await api.runtime.sendMessage({ action: 'openAttendance' });
    window.close();
  } catch (err) {
    showMessage('❌ Ouverture impossible', true);
    console.warn('[42 Reminder/popup]', err);
  }
});

refresh(true);
refreshTimer = setInterval(() => refresh(false), 1000);
window.addEventListener('unload', () => clearInterval(refreshTimer));
