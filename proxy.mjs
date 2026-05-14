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
function detectProduct(trainStr) {
  const t = (trainStr || '').toUpperCase().trim();
  if (/^ICE/.test(t))                        return 'nationalExpress';
  if (/^(IC|EC|EN|NJ|TGV|RJ|D\s)/.test(t))  return 'national';
  if (/^(IRE|RE|FLX)/.test(t))              return 'regionalExp';
  if (/^S\s?\d/.test(t))                     return 'suburban';
  if (/^(BUS|SEV|STR|TRAM|AST)/.test(t))    return null; // rausfiltern
  return 'regional'; // RB, ME, R, NWB, ... alles andere
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

function convertDepartures(raw) {
  const TRAIN_PRODUCTS = new Set([
    'nationalExpress', 'national', 'regionalExp', 'regional', 'suburban',
  ]);

  return raw
    .map(d => {
      const product = detectProduct(d.train ?? '');
      if (!product || !TRAIN_PRODUCTS.has(product)) return null;

      const plannedWhen = toISO(d.scheduledDeparture);
      const delayMin    = typeof d.delay === 'number' ? d.delay : 0;
      const actualWhen  = plannedWhen
        ? new Date(new Date(plannedWhen).getTime() + delayMin * 60_000).toISOString()
        : plannedWhen;

      return {
        direction:       d.destination ?? null,
        plannedWhen,
        when:            actualWhen,
        delay:           delayMin * 60, // in Sekunden (wie FPTF)
        cancelled:       d.isCancelled ?? false,
        plannedPlatform: d.scheduledPlatform ?? null,
        platform:        d.platform ?? d.scheduledPlatform ?? null,
        line: {
          name:    d.train ?? '',
          product,
          mode:    'train',
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
  // id ist hier der DS100-Code (z.B. "EOB")
  const id      = req.params.id;
  const results = parseInt(req.query.results ?? '20');
  console.log(`[departures] DS100 ${id}`);

  try {
    const raw        = await fetchDBF(id, results + 10);
    const departures = convertDepartures(raw).slice(0, results);
    console.log(`[departures] ${raw.length} gesamt → ${departures.length} Züge`);
    res.json({ departures });
  } catch (err) {
    console.error('[departures] Fehler:', err.message);
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

app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n✅  DBF-Server läuft   →  http://localhost:' + PORT);
  console.log('    Tafel öffnen      →  http://localhost:' + PORT + '/index.html');
  console.log('    Diagnose          →  http://localhost:' + PORT + '/health\n');
});
