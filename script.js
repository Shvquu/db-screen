/**
 * DB Abfahrtstafel – script.js
 * Holt Live-Abfahrtsdaten von transport.rest (v6.db.transport.rest)
 * Aktualisiert alle 30 Sekunden · Zeigt Verspätungen & Ausfälle
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   KONFIGURATION
════════════════════════════════════════════════════════════════════ */

const CONFIG = {
  // Suchname des Bahnhofs (wird per API aufgelöst → robuster als hartk. ID)
  stationQuery: 'Oberhausen Hbf',
  stationName:  'Oberhausen Hbf',  // Anzeigename (wird nach Lookup überschrieben)
  stationId:    null,               // wird beim Start per lookupStation() gesetzt

  // Lokaler CORS-Proxy (node proxy.js)
  apiBase: window.location.origin + '/api', // automatisch: localhost UND Domain

  // Wie viele Minuten voraus abrufen
  durationMinutes: 90,

  // Maximale Zeilen in der Anzeige
  maxRows: 20,

  // Aktualisierungsintervall in Millisekunden (30 Sekunden)
  refreshInterval: 30_000,
};

/* ═══════════════════════════════════════════════════════════════════
   BAHNHOF-LOOKUP (löst Name → ID auf)
════════════════════════════════════════════════════════════════════ */

async function lookupStation() {
  const url = `${CONFIG.apiBase}/locations?query=${encodeURIComponent(CONFIG.stationQuery)}&results=5&stops=true`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Stations-Suche: HTTP ${res.status}`);

  const data = await res.json();
  // Ersten Eintrag vom Typ "stop" oder "station" nehmen
  const stop = data.find(s => s.type === 'stop' || s.type === 'station');
  if (!stop) throw new Error(`Kein Bahnhof für "${CONFIG.stationQuery}" gefunden`);

  CONFIG.stationId   = stop.id;
  CONFIG.stationName = stop.name;
  elStationName.textContent = stop.name;
  console.log(`[Tafel] Station gefunden: ${stop.name} (ID: ${stop.id})`);
}

/* ═══════════════════════════════════════════════════════════════════
   DOM-REFERENZEN
════════════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);

const elClock       = $('clock');
const elLastUpdate  = $('lastUpdate');
const elLoadingMsg  = $('loadingMsg');
const elErrorMsg    = $('errorMsg');
const elErrorText   = $('errorText');
const elDeptList    = $('departureList');
const elStationName = $('stationName');
const elTicker      = $('tickerContent');

/* ═══════════════════════════════════════════════════════════════════
   UHRZEIT
════════════════════════════════════════════════════════════════════ */

function updateClock() {
  const now  = new Date();
  const hh   = String(now.getHours()).padStart(2, '0');
  const mm   = String(now.getMinutes()).padStart(2, '0');
  const ss   = String(now.getSeconds()).padStart(2, '0');
  elClock.textContent = `${hh}:${mm}:${ss}`;
}

setInterval(updateClock, 1000);
updateClock();

/* ═══════════════════════════════════════════════════════════════════
   HILFSFUNKTIONEN
════════════════════════════════════════════════════════════════════ */

/**
 * Gibt hh:mm aus einem ISO-Datum-String zurück.
 */
function fmtTime(isoStr) {
  if (!isoStr) return '–';
  // Immer Europe/Berlin – unabhängig von Browser- oder Serverzeitzone
  return new Date(isoStr).toLocaleTimeString('de-DE', {
    timeZone: 'Europe/Berlin',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

/**
 * Berechnet Verspätung in Minuten zwischen zwei ISO-Strings.
 * Gibt null zurück wenn keine echte Abfahrtszeit vorhanden.
 */
function calcDelay(planned, actual) {
  if (!planned || !actual) return null;
  const diff = Math.round((new Date(actual) - new Date(planned)) / 60_000);
  return diff;
}

/**
 * Gibt CSS-Klasse + Badge-Text für den Zugtyp zurück.
 */
function trainBadge(line) {
  if (!line) return { cls: 'badge-other', label: '?' };

  const name  = (line.name || '').toUpperCase();
  const mode  = (line.mode || '').toLowerCase();
  const pId   = (line.product || '').toLowerCase();

  if (/^ICE/.test(name))          return { cls: 'badge-ice',   label: name };
  if (/^IC\s|^IC\d/.test(name))   return { cls: 'badge-ic',    label: name };
  if (/^EC\s|^EC\d/.test(name))   return { cls: 'badge-ec',    label: name };
  if (/^NJ/.test(name))           return { cls: 'badge-nj',    label: name };
  if (/^RE\s|^RE\d/.test(name))   return { cls: 'badge-re',    label: name };
  if (/^RB\s|^RB\d/.test(name))   return { cls: 'badge-rb',    label: name };
  if (/^S\s?\d/.test(name))       return { cls: 'badge-s',     label: name };
  if (/^U\s?\d/.test(name))       return { cls: 'badge-u',     label: name };
  if (mode === 'bus' || pId === 'bus') return { cls: 'badge-bus', label: name || 'Bus' };

  return { cls: 'badge-other', label: name || pId || '?' };
}

/**
 * Kürzt Zielname falls zu lang.
 */
function truncate(str, max = 32) {
  if (!str) return '–';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Gibt lesbares Uhrzeit-Objekt zurück für den letzten Update-Stempel.
 */
function fmtNow() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} Uhr`;
}

/* ═══════════════════════════════════════════════════════════════════
   API-ANFRAGE
════════════════════════════════════════════════════════════════════ */

async function fetchDepartures() {
  const url = new URL(`${CONFIG.apiBase}/stops/${CONFIG.stationId}/departures`);
  url.searchParams.set('duration',  CONFIG.durationMinutes);
  url.searchParams.set('results',   CONFIG.maxRows);
  url.searchParams.set('language',  'de');

  // Nur Züge anzeigen – Busse, Tram, U-Bahn ausblenden
  url.searchParams.set('nationalExpress', 'true');   // ICE
  url.searchParams.set('national',        'true');   // IC, EC
  url.searchParams.set('regionalExp',     'true');   // RE
  url.searchParams.set('regional',        'true');   // RB
  url.searchParams.set('suburban',        'true');   // S-Bahn
  url.searchParams.set('bus',             'false');
  url.searchParams.set('ferry',           'false');
  url.searchParams.set('subway',          'false');
  url.searchParams.set('tram',            'false');
  url.searchParams.set('taxi',            'false');

  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(12_000),   // 12 s Timeout
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} – ${response.statusText}`);
  }

  const json = await response.json();

  // v6.db.transport.rest liefert { departures: [...] }
  const departures = json.departures ?? json;
  if (!Array.isArray(departures)) {
    throw new Error('Unerwartetes API-Antwortformat.');
  }
  return departures;
}

/* ═══════════════════════════════════════════════════════════════════
   ZEILE BAUEN
════════════════════════════════════════════════════════════════════ */

function buildRow(dep, index) {
  const isCancelled = dep.cancelled === true;

  const planned = dep.plannedWhen ?? dep.when;
  const actual  = dep.when ?? dep.plannedWhen;
  // Verspätung: erst aus Timestamps berechnen, dann dep.delay als Fallback
  let delay = calcDelay(planned, actual);
  if ((delay === null || delay === 0) && dep.delay) {
    // dep.delay kommt in Sekunden (FPTF) → in Minuten umrechnen
    const fallback = Math.round(dep.delay / 60);
    if (fallback !== 0) delay = fallback;
  }

  const timeStr    = fmtTime(planned);
  const badge      = trainBadge(dep.line);
  const destination = truncate(dep.direction ?? dep.destination?.name, 34);

  // Gleis
  // DBF liefert "" statt null wenn kein Gleis bekannt → normalisieren
  const platform = dep.plannedPlatform || dep.platform || null;
  const platformChanged = dep.platform && dep.plannedPlatform &&
      dep.platform !== dep.plannedPlatform;

  // Info-Text
  let infoText = '';
  if (isCancelled) {
    infoText = '⚠ Zug fällt heute aus';
  } else if (delay !== null && delay >= 5) {
    infoText = `ca. ${delay} Min. später`;
    if (dep.remarks?.length) {
      const remark = dep.remarks.find(r => r.type === 'warning' || r.type === 'status');
      if (remark?.text) infoText += ` · ${remark.text.slice(0, 60)}`;
    }
  } else if (dep.remarks?.length) {
    const remark = dep.remarks[0];
    if (remark?.text) infoText = remark.text.slice(0, 70);
  }

  /* ── Zeilen-Klassen ──────────────────────────────────────────── */
  let rowClass = 'departure-row';
  if (isCancelled) rowClass += ' cancelled';
  else if (delay !== null && delay >= 5) rowClass += ' delayed';

  /* ── Verspätungs-Badge ───────────────────────────────────────── */
  let delayHTML = '';
  if (isCancelled) {
    delayHTML = `<span class="dep-delay cancelled-label">Ausfall</span>`;
  } else if (delay === null || delay === 0) {
    delayHTML = `<span class="dep-delay on-time">pünktl.</span>`;
  } else if (delay > 0) {
    delayHTML = `<span class="dep-delay late">+${delay}'</span>`;
  } else {
    // früher
    delayHTML = `<span class="dep-delay on-time">${delay}'</span>`;
  }

  /* ── Info-Lauftext ───────────────────────────────────────────── */
  const infoClass = infoText.length > 30 ? 'ticker-inner running' : 'ticker-inner';
  const infoHTML  = infoText
      ? `<span class="${infoClass}">${infoText}</span>`
      : '';

  /* ── Plattform ───────────────────────────────────────────────── */
  const platClass = platformChanged
      ? 'dep-platform changed'
      : platform ? 'dep-platform' : 'dep-platform unknown';
  const platLabel = platformChanged
      ? `⟶${dep.platform}`
      : platform || '?';

  /* ── HTML zusammenbauen ──────────────────────────────────────── */
  const row = document.createElement('div');
  row.className = rowClass;
  row.style.animationDelay = `${index * 0.04}s`;

  row.innerHTML = `
    <div class="dep-time col-time">${timeStr}</div>
    ${delayHTML}
    <div class="dep-type col-type">
      <span class="train-badge ${badge.cls}">${badge.label}</span>
    </div>
    <div class="dep-destination col-destination">${destination}</div>
    <div class="${platClass} col-platform">${platLabel}</div>
    <div class="dep-info col-info">${infoHTML}</div>
  `;

  return row;
}

/* ═══════════════════════════════════════════════════════════════════
   TICKER AKTUALISIEREN (Fusszeile)
════════════════════════════════════════════════════════════════════ */

function updateTicker(departures) {
  const delayed    = departures.filter(d => !d.cancelled && calcDelay(d.plannedWhen ?? d.when, d.when ?? d.plannedWhen) >= 5);
  const cancelled  = departures.filter(d => d.cancelled);

  const parts = [];

  cancelled.forEach(d => {
    const name = d.line?.name ?? '–';
    const dest = d.direction ?? d.destination?.name ?? '–';
    parts.push(`⚠ AUSFALL: ${name} → ${dest}`);
  });

  delayed.forEach(d => {
    const name  = d.line?.name ?? '–';
    const dest  = d.direction ?? d.destination?.name ?? '–';
    const delay = calcDelay(d.plannedWhen ?? d.when, d.when ?? d.plannedWhen);
    parts.push(`${name} → ${dest}: ca. ${delay} Min. Verspätung`);
  });

  if (parts.length > 0) {
    elTicker.textContent = parts.join('   ·   ') + '   ·   ';
  } else {
    elTicker.textContent =
        'Alle Züge fahren planmäßig.  ·  Bitte beachten Sie Ansagen auf dem Bahnsteig.  ·  ' +
        'Please listen to platform announcements.  ·  ';
  }
}

/* ═══════════════════════════════════════════════════════════════════
   ANZEIGE RENDERN
════════════════════════════════════════════════════════════════════ */

function renderDepartures(departures) {
  // Sortierung: nach geplanter Abfahrtszeit
  departures.sort((a, b) => {
    const ta = new Date(a.plannedWhen ?? a.when ?? 0).getTime();
    const tb = new Date(b.plannedWhen ?? b.when ?? 0).getTime();
    return ta - tb;
  });

  // Nur künftige (oder max. 2 Min. in der Vergangenheit)
  const cutoff = Date.now() - 2 * 60_000;
  const visible = departures
      .filter(d => new Date(d.when ?? d.plannedWhen ?? 0).getTime() >= cutoff)
      .slice(0, CONFIG.maxRows);

  elDeptList.innerHTML = '';

  if (visible.length === 0) {
    elDeptList.innerHTML = `
      <div class="status-message">
        <span style="color:var(--gray)">Keine Abfahrten in den nächsten ${CONFIG.durationMinutes} Minuten.</span>
      </div>`;
  } else {
    visible.forEach((dep, idx) => {
      elDeptList.appendChild(buildRow(dep, idx));
    });
  }

  updateTicker(visible);

  // Sprachansagen werden von index.html inline-script ausgeführt
  if (window._announcer) window._announcer(visible);

  elLastUpdate.textContent = fmtNow();
  elStationName.textContent = CONFIG.stationName;
}

/* ═══════════════════════════════════════════════════════════════════
   HAUPT-LADE-FUNKTION
════════════════════════════════════════════════════════════════════ */

let isFirstLoad = true;

async function load() {
  if (isFirstLoad) {
    // Beim ersten Start: Ladeanzeige
    show(elLoadingMsg);
    hide(elErrorMsg);
    hide(elDeptList);
  }

  try {
    const data = await fetchDepartures();
    renderDepartures(data);

    hide(elLoadingMsg);
    hide(elErrorMsg);
    show(elDeptList);
    isFirstLoad = false;

  } catch (err) {
    console.error('[Abfahrtstafel] Fehler:', err);

    if (isFirstLoad) {
      hide(elLoadingMsg);
      elErrorText.textContent =
          `API nicht erreichbar: ${err.message}. ` +
          `Starten Sie den Proxy (node proxy.js) oder prüfen Sie Ihre Verbindung.`;
      show(elErrorMsg);
    } else {
      // Im Hintergund-Refresh: alten Inhalt behalten, Fehler in Ticker
      elTicker.textContent =
          '⚠ Aktualisierung fehlgeschlagen – zeige zuletzt geladene Daten  ·  ';
    }
  }
}

/* ── Sichtbarkeitshelfer ────────────────────────────────────────── */
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

/* ═══════════════════════════════════════════════════════════════════
   START – erst Station suchen, dann Daten laden
════════════════════════════════════════════════════════════════════ */

async function init() {
  show(elLoadingMsg);
  hide(elErrorMsg);
  hide(elDeptList);

  try {
    // Station-ID dynamisch ermitteln
    await lookupStation();
  } catch (err) {
    hide(elLoadingMsg);
    elErrorText.textContent = `Station nicht gefunden: ${err.message}. Proxy läuft? → node proxy.js`;
    show(elErrorMsg);
    return;
  }

  // Ersten Ladevorgang starten
  await load();

  // Danach alle 30 Sekunden
  setInterval(load, CONFIG.refreshInterval);
}

init();