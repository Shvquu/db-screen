/**
 * proxy.mjs – DB Abfahrtstafel via dbf.finalrewind.org (IRIS JSON API)
 * Stabile JSON-API, kein IP-Block, kein Auth, kein XML-Parsing
 * Install:  npm install express cors
 * Starten:  node proxy.mjs
 */

import express           from 'express';
import cors              from 'cors';
import { fileURLToPath } from 'url';
import { dirname }       from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = 3000;
app.use(cors());

/* ══════════════════════════════════════════════════════════════════
   DS100-Stationsdatenbank  (DS100 → Name + EVA für script.js)
   DS100-Codes: https://dbf.finalrewind.org/{DS100}.json?version=3
════════════════════════════════════════════════════════════════════ */
const STATIONS = {
  'oberhausen hbf':  { ds100: 'EOB',  name: 'Oberhausen Hbf',      id: 'EOB'  },
  'oberhausen':      { ds100: 'EOB',  name: 'Oberhausen Hbf',      id: 'EOB'  },
  'duisburg hbf':    { ds100: 'EDU',  name: 'Duisburg Hbf',        id: 'EDU'  },
  'essen hbf':       { ds100: 'EE',   name: 'Essen Hbf',           id: 'EE'   },
  'dortmund hbf':    { ds100: 'EDO',  name: 'Dortmund Hbf',        id: 'EDO'  },
  'düsseldorf hbf':  { ds100: 'ED',   name: 'Düsseldorf Hbf',      id: 'ED'   },
  'köln hbf':        { ds100: 'KK',   name: 'Köln Hbf',            id: 'KK'   },
  'frankfurt hbf':   { ds100: 'FF',   name: 'Frankfurt(Main)Hbf',  id: 'FF'   },
  'hamburg hbf':     { ds100: 'AH',   name: 'Hamburg Hbf',         id: 'AH'   },
  'berlin hbf':      { ds100: 'BLS',  name: 'Berlin Hbf',          id: 'BLS'  },
  'münchen hbf':     { ds100: 'MH',   name: 'München Hbf',         id: 'MH'   },
  'bochum hbf':      { ds100: 'EBO',  name: 'Bochum Hbf',          id: 'EBO'  },
  'gelsenkirchen hbf':{ ds100: 'EG',  name: 'Gelsenkirchen Hbf',   id: 'EG'   },
};

/* ══════════════════════════════════════════════════════════════════
   DBF JSON-API ABRUFEN
   URL-Schema: https://dbf.finalrewind.org/{DS100}.json?version=3&limit=N
════════════════════════════════════════════════════════════════════ */
async function fetchDBF(ds100, limit = 25) {
  const url = `https://dbf.finalrewind.org/${ds100}.json?version=3&limit=${limit}`;
  console.log(`[DBF] GET ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept':     'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) throw new Error(`DBF HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`DBF Fehler: ${data.error}`);
  return data.departures ?? [];
}

/* ══════════════════════════════════════════════════════════════════
   DBF-Format → FPTF-Format (kompatibel mit script.js)
════════════════════════════════════════════════════════════════════ */
// Betreiber-Prefix entfernen: "RRB RB36" → "RB36", "ERB RE3" → "RE3", "S S3" → "S3"
function cleanTrainName(raw) {
  const s = (raw || '').trim();
  // Wenn zwei Token: prüfe ob zweiter Token ein bekannter Zugtyp ist
  const m = s.match(/^\S+\s+((?:ICE|IC|EC|EN|NJ|TGV|RJ|IRE|RE|RB|ME|NX|FLX|S|U)\s?\w+)$/i);
  if (m) return m[1].trim();
  // "S S3" → "S3" (S-Bahn doppelt)
  const s2 = s.match(/^S\s+(S\d+)$/i);
  if (s2) return s2[1];
  return s;
}

function detectProduct(trainStr) {
  const t = cleanTrainName(trainStr).toUpperCase().trim();
  if (/^ICE/.test(t))                         return 'nationalExpress';
  if (/^(IC|EC|EN|NJ|TGV|RJ|D\s)/.test(t))   return 'national';
  if (/^(IRE|RE|FLX)/.test(t))               return 'regionalExp';
  if (/^S\s?\d/.test(t))                      return 'suburban';
  if (/^(BUS|SEV|STR|TRAM|AST)/.test(t))     return null;
  return 'regional';
}

// Aktuelles Datum in Europe/Berlin als "YYYY-MM-DD"
function berlinDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);  // z.B. "2026-05-14"
}

// UTC-Offset Berlin in Stunden (+1 oder +2)
function berlinOffset(d = new Date()) {
  const berlinStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);  // z.B. "23:46:00"
  const berlinMs = new Date(`${berlinDateStr(d)}T${berlinStr}Z`).getTime();
  return Math.round((berlinMs - d.getTime()) / 3_600_000);
}

// "HH:MM" (Berlin-Lokalzeit aus DBF) → ISO-String
function toISO(timeStr) {
  if (!timeStr) return null;
  const now  = new Date();
  const off  = berlinOffset(now);
  const sign = off >= 0 ? '+' : '-';
  const offStr = `${sign}${String(Math.abs(off)).padStart(2, '0')}:00`;
  const date   = berlinDateStr(now);          // "2026-05-14"
  let   iso    = new Date(`${date}T${timeStr}:00${offStr}`);
  // Wenn Zeit mehr als 2 Min in der Vergangenheit → morgen
  if (iso.getTime() < now.getTime() - 2 * 60_000) {
    const tomorrow = new Date(now.getTime() + 24 * 3_600_000);
    iso = new Date(`${berlinDateStr(tomorrow)}T${timeStr}:00${offStr}`);
  }
  return iso.toISOString();
}

const TRAIN_PRODUCTS = new Set([
  'nationalExpress', 'national', 'regionalExp', 'regional', 'suburban',
]);

function convertDepartures(raw, mode = 'trains') {
  return raw
      .map(d => {
        const product = detectProduct(d.train ?? '');

        if (mode === 'buses') {
          // Bus-Modus: nur Busse anzeigen
          if (product !== null) return null; // kein Bus
          // Busse haben product === null nach detectProduct
        } else {
          // Zug-Modus: nur Züge
          if (!product || !TRAIN_PRODUCTS.has(product)) return null;
        }

        // plannedWhen = geplante Zeit, when = tatsächliche Zeit (mit Verspätung)
        const plannedWhen = toISO(d.scheduledDeparture);
        // DBF liefert delayDeparture (Minuten, Zahl)
        const delayMin = typeof d.delayDeparture === 'number' ? d.delayDeparture
            : typeof d.delay          === 'number' ? d.delay
                : 0;

        // Tatsächliche Abfahrtszeit = geplant + Verspätung
        const actualWhen = plannedWhen && delayMin !== 0
            ? new Date(new Date(plannedWhen).getTime() + delayMin * 60_000).toISOString()
            : plannedWhen;

        // isCancelled ist 0/1 (Zahl) bei DBF, kein Boolean
        const cancelled = !!(d.isCancelled || d.cancelled);

        const isBus = (product === null);
        return {
          direction:       d.destination ?? null,
          plannedWhen,
          when:            actualWhen,
          delay:           delayMin * 60,
          cancelled,
          plannedPlatform: d.scheduledPlatform || d.platform || null,
          platform:        d.platform || d.scheduledPlatform || null,
          line: {
            name:    isBus ? (d.train ?? 'Bus') : cleanTrainName(d.train ?? ''),
            product: isBus ? 'bus' : product,
            mode:    isBus ? 'bus' : 'train',
          },
        };
      })
      .filter(Boolean);
}

/* ══════════════════════════════════════════════════════════════════
   ENDPUNKTE (gleiche URLs wie bisher – script.js braucht nichts ändern)
════════════════════════════════════════════════════════════════════ */

app.get('/api/locations', (req, res) => {
  const query = (req.query.query ?? '').trim().toLowerCase();
  const s = STATIONS[query]
      ?? Object.values(STATIONS).find(x => x.name.toLowerCase().includes(query));
  if (!s) return res.status(404).json({ error: `Nicht gefunden: ${query}` });
  res.json([{ type: 'stop', id: s.id, name: s.name }]);
});

app.get('/api/stops/:id/departures', async (req, res) => {
  const id      = req.params.id;
  const results = parseInt(req.query.results ?? '20');
  const mode    = req.query.mode === 'buses' ? 'buses' : 'trains';
  console.log(`[departures] DS100 ${id} · Modus: ${mode}`);

  try {
    const raw        = await fetchDBF(id, results + 15);
    const departures = convertDepartures(raw, mode).slice(0, results);
    console.log(`[departures] ${raw.length} gesamt → ${departures.length} (${mode})`);
    res.json({ departures });
  } catch (err) {
    console.error('[departures] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug: zeigt rohe DBF-Antwort für die ersten 3 Einträge
app.get('/debug', async (_req, res) => {
  try {
    const url = 'https://dbf.finalrewind.org/EOB.json?version=3&limit=5';
    const r   = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const data = await r.json();
    // Zeige rohe Felder der ersten Abfahrten
    const sample = (data.departures ?? []).slice(0, 5).map(d => ({
      train:             d.train,
      scheduledDeparture:d.scheduledDeparture,
      departure:         d.departure,
      delay:             d.delay,
      delayDeparture:    d.delayDeparture,
      isCancelled:       d.isCancelled,
      cancelled:         d.cancelled,
      scheduledPlatform: d.scheduledPlatform,
      platform:          d.platform,
      destination:       d.destination,
      // alle Keys zeigen
      _allKeys: Object.keys(d),
    }));
    res.json({ raw: sample });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (_req, res) => {
  try {
    const raw  = await fetchDBF('EOB', 5);
    const deps = convertDepartures(raw);
    res.json({ status: 'ok', station: 'Oberhausen Hbf', departures: deps.length });
  } catch (err) {
    res.status(500).json({ status: 'error', detail: err.message });
  }
});


/* ══════════════════════════════════════════════════════════════════
   VRR EFA API – STOAG & andere Busse im VRR-Netz
════════════════════════════════════════════════════════════════════ */

// Stationsname für VRR-Suche (name-basiert, keine hardcodierte Stop-ID)
const VRR_STATION_NAMES = {
  'EOB': 'Oberhausen Hbf',
  'EE':  'Essen Hbf',
  'EDU': 'Duisburg Hbf',
  'EDO': 'Dortmund Hbf',
};

// Cache für VRR Stop-IDs (werden per Stopfinder ermittelt)
const vrrStopIdCache = {};

async function resolveVRRStopId(stationName) {
  if (vrrStopIdCache[stationName]) return vrrStopIdCache[stationName];

  const url = new URL('https://efa.vrr.de/vrr/XSLT_STOPFINDER_REQUEST');
  url.searchParams.set('outputFormat', 'rapidJSON');
  url.searchParams.set('type_sf',      'any');
  url.searchParams.set('name_sf',      stationName);
  url.searchParams.set('language',     'de');

  //console.log(`[VRR Stopfinder] ${url}`);
  const res  = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Stopfinder HTTP ${res.status}`);
  const data = await res.json();

  // Ersten passenden Stop nehmen
  const locations = data?.locations ?? data?.stopFinder?.points ?? [];
  //console.log(`[VRR Stopfinder] ${locations.length} Treffer`);
  if (locations.length > 0) {
    console.log('[VRR Stopfinder] Erster Treffer:', JSON.stringify(locations[0]).slice(0, 200));
  }

  const stop = locations.find(l => l.type === 'stop' || l.type === 'platform' || l.isGlobalId)
      ?? locations[0];
  if (!stop) throw new Error(`Keine VRR-Haltestelle für "${stationName}"`);

  const stopId = stop.id ?? stop.stateless ?? stop.stopId;
  //console.log(`[VRR] "${stationName}" → Stop-ID: ${stopId}`);
  vrrStopIdCache[stationName] = stopId;
  return stopId;
}

async function fetchVRRBuses(ds100, limit = 25) {
  const stationName = VRR_STATION_NAMES[ds100];
  if (!stationName) throw new Error(`Kein VRR-Name für DS100 ${ds100}`);

  // Schritt 1: Stop-ID ermitteln
  const stopId = await resolveVRRStopId(stationName);

  // Schritt 2: Abfahrten abrufen
  const now  = new Date();
  const date = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now).split('.').reverse().join('').replace(/[^0-9]/g,'').slice(0,8);
  const time = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now).replace(':', '');

  const url = new URL('https://efa.vrr.de/vrr/XSLT_DM_REQUEST');
  url.searchParams.set('outputFormat',   'rapidJSON');
  url.searchParams.set('language',       'de');
  url.searchParams.set('type_dm',        'stopID');
  url.searchParams.set('name_dm',        stopId);
  url.searchParams.set('mode',           'direct');
  url.searchParams.set('useRealtime',    '1');
  url.searchParams.set('limit',          String(limit + 10));
  url.searchParams.set('itdDate',        date);
  url.searchParams.set('itdTime',        time);
  url.searchParams.set('ptOptionsActive','1');
  url.searchParams.set('mergeDep',       '1');

  console.log(`[VRR] GET ${url.toString()}`);
  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`VRR EFA HTTP ${res.status}`);
  const data = await res.json();
  return convertVRR(data, limit);
}

function convertVRR(data, limit = 25) {
  const deps = data?.stopEvents ?? data?.departureList ?? [];
  console.log(`[VRR] ${deps.length} stopEvents empfangen`);
  if (deps.length > 0) {
    const t = deps[0].transportation ?? {};
    //console.log('[VRR] transportation keys:', Object.keys(t));
    //console.log('[VRR] product:', JSON.stringify(t.product));
    //console.log('[VRR] destination:', JSON.stringify(t.destination));
    //console.log('[VRR] departureTimePlanned:', deps[0].departureTimePlanned);
  }

  const result  = [];
  const cutoff  = Date.now() - 2 * 60_000;

  for (const d of deps) {
    try {
      const t        = d.transportation ?? {};
      const product  = t.product ?? {};
      const motClass = parseInt(product.class ?? product.motType ?? '99');
      const lineName = t.number ?? t.disassembledName ?? t.name ?? '?';

      // VRR Klassen: 1=ICE, 2=IC, 3=IR, 4=RE/RB, 5=Niederflurbus/Bus,
      // 6=U-Bahn, 7=Stadtbahn/Tram, 8=Regionalbus, 9=AST, 10=Fähre
      const BUS_CLASSES = new Set([5, 8, 9]); // 5=Stadtbus, 8=Regionalbus, 9=Nachtbus/AST
      const isBus = BUS_CLASSES.has(motClass)
          || (product.name ?? '').toLowerCase().includes('bus');
      // U-Bahn und Stadtbahn/Tram ausschließen
      if (!isBus || motClass === 6 || motClass === 7) continue;

      const dest = t.destination?.name ?? t.direction ?? '?';

      // Zeiten: ISO-Strings direkt nutzbar
      const plannedWhen = d.departureTimePlanned ?? null;
      const actualWhen  = d.departureTimeEstimated ?? plannedWhen;
      if (!plannedWhen) continue;
      // VRR Zeiten sind UTC ISO-Strings → direkt vergleichbar
      const plannedMs = new Date(plannedWhen).getTime();
      if (plannedMs < Date.now() - 5 * 60_000) continue; // max 5 Min Vergangenheit

      const delaySec = actualWhen
          ? Math.round((new Date(actualWhen) - new Date(plannedWhen)) / 1000)
          : 0;

      const platform = d.location?.properties?.platform ?? null;

      result.push({
        direction:       dest,
        plannedWhen,
        when:            actualWhen ?? plannedWhen,
        delay:           delaySec,
        cancelled:       false,
        plannedPlatform: platform,
        platform,
        line: { name: lineName, product: 'bus', mode: 'bus' },
      });

      if (result.length >= limit) break;
    } catch (e) {
      console.warn('[VRR] Parse-Fehler:', e.message);
    }
  }

  console.log(`[VRR] ${result.length} Busse nach Filter`);
  return result;
}

/* ── VRR Debug ──────────────────────────────────────────────────── */
app.get('/vrr-debug', async (_req, res) => {
  try {
    const now  = new Date();
    const date = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).split('.').reverse().join('').replace(/\D/g,'').slice(0,8);
    const time = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '');

    const url = new URL('https://efa.vrr.de/vrr/XSLT_DM_REQUEST');
    url.searchParams.set('outputFormat',   'rapidJSON');
    url.searchParams.set('language',       'de');
    url.searchParams.set('type_dm',        'stopID');
    url.searchParams.set('name_dm',        '20018226');
    url.searchParams.set('mode',           'direct');
    url.searchParams.set('useRealtime',    '1');
    url.searchParams.set('limit',          '5');
    url.searchParams.set('itdDate',        date);
    url.searchParams.set('itdTime',        time);
    url.searchParams.set('ptOptionsActive','1');
    url.searchParams.set('mergeDep',       '1');

    const r    = await fetch(url.toString(), { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) });
    const data = await r.json();

    // Zeige Rohdaten: Top-Level-Keys + erste Abfahrt komplett
    const topKeys = Object.keys(data);
    const firstDep = (data.departureList ?? data.stopEvents ?? data.departures ?? [])[0] ?? null;
    res.json({ status: r.status, topKeys, firstDep, totalItems: (data.departureList ?? data.stopEvents ?? []).length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── VRR Bus-Endpunkt ───────────────────────────────────────────── */
app.get('/api/stops/:id/buses', async (req, res) => {
  const id      = req.params.id;
  const results = parseInt(req.query.results ?? '20');
  console.log(`[buses] DS100 ${id}`);
  try {
    const departures = await fetchVRRBuses(id, results);
    console.log(`[buses] ${departures.length} Busse`);
    res.json({ departures });
  } catch (err) {
    console.error('[buses] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n✅  DBF-Server läuft   →  https://db.kreuzenbeck.net');
  console.log('    Tafel öffnen      →  https://db.kreuzenbeck.net/index.html');
  console.log('    Diagnose          →  https://db.kreuzenbeck.net/health\n');
});
