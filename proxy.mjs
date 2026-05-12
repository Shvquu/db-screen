/**
 * proxy.mjs – Lokaler DB-Fahrplanserver (kein externer API-Aufruf nötig)
 * Verwendet db-vendo-client direkt – kein Rate-Limit, kein 503!
 *
 * Install:  npm install hafas-client db-vendo-client express cors
 * Starten:  node proxy.mjs
 */

import { createClient }   from 'hafas-client';
import { profile }        from 'db-vendo-client/p/db/index.js';
import express            from 'express';
import cors               from 'cors';
import { createRequire }  from 'module';
import { fileURLToPath }  from 'url';
import { dirname }        from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// HAFAS-Client mit DB-Profil initialisieren
const client = createClient(profile, 'db-abfahrtstafel/1.0');

const app  = express();
const PORT = 3000;

app.use(cors());

/* ── Bahnhofssuche ──────────────────────────────────────────────── */
app.get('/api/locations', async (req, res) => {
  try {
    const query   = req.query.query ?? '';
    const results = parseInt(req.query.results ?? '5');
    const stops   = await client.locations(query, { results, stops: true, addresses: false, poi: false });
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

    const opt = {
      duration,
      results,
      language:        'de',
      nationalExpress: req.query.nationalExpress !== 'false',
      national:        req.query.national        !== 'false',
      regionalExp:     req.query.regionalExp     !== 'false',
      regional:        req.query.regional        !== 'false',
      suburban:        req.query.suburban        !== 'false',
      bus:             req.query.bus             === 'true',
      ferry:           req.query.ferry           === 'true',
      subway:          req.query.subway          === 'true',
      tram:            req.query.tram            === 'true',
      taxi:            false,
    };

    console.log(`[departures] Stop ${id}, ${duration} min, ${results} results`);
    const { departures } = await client.departures(id, opt);
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
    res.json({ status: 'ok', station: stops[0]?.name ?? '?', id: stops[0]?.id ?? '?' });
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
