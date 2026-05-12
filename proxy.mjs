/**
 * proxy.mjs – Lokaler DB-Fahrplanserver via db-vendo-client
 * Install:  npm install db-vendo-client express cors
 * Starten:  node proxy.mjs
 */

// ── WICHTIG: createClient kommt aus db-vendo-client, NICHT aus hafas-client ──
import { createClient }      from 'db-vendo-client';
import { profile as dbProfile } from 'db-vendo-client/p/dbnav/index.js';
import express               from 'express';
import cors                  from 'cors';
import { fileURLToPath }     from 'url';
import { dirname }           from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Client mit DB-Navigator-Profil (stabilstes Profil, kein API-Key nötig)
const client = createClient(dbProfile, 'db-abfahrtstafel/1.0');

const app  = express();
const PORT = 3000;
app.use(cors());

/* ── Bahnhofssuche ──────────────────────────────────────────────── */
app.get('/api/locations', async (req, res) => {
  try {
    const query   = req.query.query ?? '';
    const results = parseInt(req.query.results ?? '5');
    console.log(`[locations] Suche: "${query}"`);
    const stops = await client.locations(query, {
      results,
      stops:     true,
      addresses: false,
      poi:       false,
    });
    res.json(stops);
  } catch (err) {
    console.error('[locations] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Abfahrten ──────────────────────────────────────────────────── */
app.get('/api/stops/:id/departures', async (req, res) => {
  try {
    const id       = req.params.id;
    const duration = parseInt(req.query.duration ?? '90');
    const results  = parseInt(req.query.results  ?? '20');

    console.log(`[departures] Stop ${id}, ${duration} min`);

    // Mehr Ergebnisse abrufen als nötig, da wir Busse danach rausfiltern
    const { departures: raw } = await client.departures(id, {
      duration,
      results: results * 3,  // Puffer für Filter
      language: 'de',
    });

    // Nur Züge behalten – Busse, Tram, Fähre, Taxi rausfiltern
    const TRAIN_PRODUCTS = new Set([
      'nationalExpress', 'national', 'regionalExp', 'regional', 'suburban',
    ]);

    const departures = raw.filter(dep => {
      const product = dep.line?.product ?? '';
      const name    = (dep.line?.name ?? '').toUpperCase();
      // Raus: alles was kein Zug ist
      if (!TRAIN_PRODUCTS.has(product)) return false;
      // Raus: Namen die mit BUS, STR (Straßenbahn) anfangen
      if (/^(BUS|STR|TRAM|TAXI|FÄHR)/.test(name)) return false;
      return true;
    }).slice(0, results);

    console.log(`[departures] ${raw.length} gesamt → ${departures.length} Züge nach Filter`);
    res.json({ departures });
  } catch (err) {
    console.error('[departures] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Diagnose ───────────────────────────────────────────────────── */
app.get('/health', async (_req, res) => {
  try {
    const stops = await client.locations('Oberhausen Hbf', { results: 1 });
    const s = stops[0];
    res.json({ status: 'ok', station: s?.name ?? '?', id: s?.id ?? '?' });
  } catch (err) {
    res.status(500).json({ status: 'error', detail: err.message });
  }
});

/* ── Statische Dateien ──────────────────────────────────────────── */
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log('\n✅  Lokaler DB-Server läuft  →  http://localhost:' + PORT);
  console.log('    Tafel öffnen             →  http://localhost:' + PORT + '/index.html');
  console.log('    Diagnose                 →  http://localhost:' + PORT + '/health\n');
});
