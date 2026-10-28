const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

// Browser-aehnlicher User-Agent: node-fetch/2.x wird von Bot-Schutz haeufig geblockt
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

app.use(express.json({ limit: '15mb' }));

// CORS + Teams iframe headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-OP-URL, X-OP-KEY');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('X-Frame-Options', 'ALLOWALL');
  res.header('Content-Security-Policy', "frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com https://*.sharepoint.com https://*.office.com");
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve dashboard HTML
// HTML, Skripte und Manifest nie ungeprueft aus dem Cache verwenden:
// Browser und installierte Web-App fragen bei jedem Start nach, ob es eine neue Version gibt
// (bei unveraenderter Datei antwortet der Server kurz mit 304, es wird nichts neu geladen).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|json|webmanifest)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Proxy endpoint for OpenProject API (GET + POST)
app.all('/proxy/*', async (req, res) => {
  const opUrl = req.headers['x-op-url'];
  const opKey = req.headers['x-op-key'];
  if (!opUrl || !opKey) return res.status(400).json({ error: 'Missing headers' });
  const apiPath = req.url.replace('/proxy', '/api/v3');
  const targetUrl = opUrl.replace(/\/$/, '') + apiPath;
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from('apikey:' + opKey).toString('base64'),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': BROWSER_UA
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined
    });

    const text  = await response.text();
    const ctype = response.headers.get('content-type') || '-';

    // Leerer Body (z.B. 204 nach DELETE) ist kein Fehler
    if (!text) return res.status(response.status).end();

    try {
      return res.status(response.status).json(JSON.parse(text));
    } catch (parseErr) {
      console.error('[proxy] Kein JSON von OpenProject:', response.status, ctype,
                    text.slice(0, 200).replace(/\s+/g, ' '));
      return res.status(502).json({
        error: 'OpenProject lieferte kein JSON',
        opStatus: response.status,
        contentType: ctype,
        preview: text.slice(0, 300)
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PDF-Extraktion via Claude AI
app.post('/extract-pdf', async (req, res) => {
  const { pdfBase64 } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY nicht gesetzt. Bitte in Render als Umgebungsvariable hinterlegen.' });
  }
  if (!pdfBase64) {
    return res.status(400).json({ error: 'Kein pdfBase64 im Request-Body.' });
  }

  const prompt = `Du bekommst einen Kunden-Steckbrief (Projektsteckbrief) als PDF.
Extrahiere folgende Daten und antworte NUR mit einem validen JSON-Objekt – kein erklärender Text davor oder danach, keine Markdown-Backticks.

JSON-Schema (alle Werte als String, fehlende Felder als leerer String ""):
{
  "projektname": "Firmenname / Projektname des Kunden",
  "kundennummer": "Kundennummer, z.B. kunde002577",
  "standort": "Vollständige Adresse oder Ort",
  "ansprechpartner_name": "Name des ersten Ansprechpartners",
  "ansprechpartner_mail": "E-Mail des ersten Ansprechpartners",
  "ansprechpartner_telefon": "Telefon des ersten Ansprechpartners",
  "outlook": "eines von: aktiv | beauftragt | gewünscht | nicht_aktiv | unbekannt",
  "ad_integration": "eines von: aktiv | beauftragt | gewünscht | nicht_aktiv | unbekannt"
}

Regeln für outlook und ad_integration:
- "aktiv" wenn das Feld ein Häkchen, "aktiv" oder eine Versionsnummer enthält
- "beauftragt" wenn beauftragt/in Bearbeitung
- "gewünscht" wenn gewünscht/angefragt
- "nicht_aktiv" wenn explizit leer oder "Nicht Aktiv"
- "unbekannt" wenn kein Hinweis vorhanden oder das Feld fehlt komplett`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }]
      })
    });

    const claudeData = await response.json();
    if (!response.ok) {
      throw new Error(claudeData.error?.message || 'Claude API Fehler ' + response.status);
    }

    const rawText = claudeData.content?.[0]?.text || '{}';
    const cleaned = rawText.replace(/```json\n?|```\n?/g, '').trim();
    const extracted = JSON.parse(cleaned);

    res.json({ success: true, data: extracted });

  } catch (err) {
    console.error('extract-pdf error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────
// Einsatzbericht: Datei als Anhang an ein Arbeitspaket hochladen.
// Der generische /proxy/* reicht den Body als JSON weiter, OpenProject
// erwartet fuer Anhaenge aber multipart/form-data (Teile "metadata" + "file").
// Body: { wpId, fileName, base64, contentType?, description? }
// ────────────────────────────────────────────────────────
app.post('/upload-attachment', async (req, res) => {
  const opUrl = req.headers['x-op-url'];
  const opKey = req.headers['x-op-key'];
  const { wpId, fileName, base64, contentType, description } = req.body || {};
  if (!opUrl || !opKey) return res.status(400).json({ error: 'Missing headers' });
  if (!/^\d+$/.test(String(wpId || '')) || !fileName || !base64) {
    return res.status(400).json({ error: 'wpId, fileName und base64 sind erforderlich' });
  }

  const fileBuf  = Buffer.from(base64, 'base64');
  const mime     = contentType || 'application/pdf';
  const asciiName = String(fileName).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const boundary = '----welcomeEB' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const metadata = JSON.stringify(description
    ? { fileName, description: { raw: description } }
    : { fileName });

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"\r\n` +
      `Content-Type: application/json; charset=utf-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${asciiName}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`, 'utf8'),
    fileBuf,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  ]);

  const targetUrl = opUrl.replace(/\/$/, '') + `/api/v3/work_packages/${wpId}/attachments`;
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from('apikey:' + opKey).toString('base64'),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        'Accept': 'application/json',
        'User-Agent': BROWSER_UA
      },
      body
    });
    const text  = await response.text();
    const ctype = response.headers.get('content-type') || '-';
    if (!text) return res.status(response.status).end();
    try {
      return res.status(response.status).json(JSON.parse(text));
    } catch (parseErr) {
      console.error('[upload-attachment] Kein JSON von OpenProject:', response.status, ctype,
                    text.slice(0, 200).replace(/\s+/g, ' '));
      return res.status(502).json({
        error: 'OpenProject lieferte kein JSON',
        opStatus: response.status,
        contentType: ctype,
        preview: text.slice(0, 300)
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────
// InvenTree-Proxy: /inv/<pfad>  ->  <INVENTREE_URL>/api/<pfad>
// Ziel-URL ist fest (Env INVENTREE_URL), der Token kommt pro Anfrage im Header X-INV-TOKEN.
// ────────────────────────────────────────────────────────
const INVENTREE_URL = (process.env.INVENTREE_URL || 'https://inventree.welcomeyou.net').replace(/\/$/, '');

app.all('/inv/*', async (req, res) => {
  const token = req.headers['x-inv-token'];
  if (!token) return res.status(400).json({ error: 'Missing X-INV-TOKEN header' });
  const targetUrl = INVENTREE_URL + req.url.replace(/^\/inv/, '/api');
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Authorization': 'Token ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': BROWSER_UA
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body || {}) : undefined
    });
    const text  = await response.text();
    const ctype = response.headers.get('content-type') || '-';
    if (!text) return res.status(response.status).end();
    try {
      return res.status(response.status).json(JSON.parse(text));
    } catch (parseErr) {
      console.error('[inv] Kein JSON von InvenTree:', response.status, ctype, text.slice(0, 200).replace(/\s+/g, ' '));
      return res.status(502).json({ error: 'InvenTree lieferte kein JSON', invStatus: response.status, contentType: ctype, preview: text.slice(0, 300) });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────
// Lieferschein auslesen (PDF oder Bild) -> strukturierte Positionen
// Body: { base64, mediaType }   (application/pdf | image/png | image/jpeg | image/webp)
// ────────────────────────────────────────────────────────
app.post('/extract-delivery', async (req, res) => {
  const { base64, mediaType } = req.body || {};
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY nicht gesetzt.' });
  if (!base64) return res.status(400).json({ error: 'Keine Datei übergeben.' });
  const isPdf = (mediaType || 'application/pdf') === 'application/pdf';
  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const prompt = `Du bekommst einen Lieferschein eines Hardware-Lieferanten.
Extrahiere alle Positionen und antworte NUR mit einem validen JSON-Objekt – kein Text davor oder danach, keine Markdown-Backticks.

{
  "lieferant": "Name des Absenders/Lieferanten, z.B. INGRAM MICRO DISTRIBUTION GMBH",
  "lieferschein_nr": "Sendungs-/Lieferscheinnummer",
  "datum": "Datum im Format YYYY-MM-DD",
  "auftrag_nr": "Auftragsnummer des Lieferanten",
  "bestell_nr": "Kunden-Bestellnummer / Dealer PO",
  "positionen": [
    {
      "pos": "Positionsnummer",
      "artikel_nr": "Artikelnummer des Lieferanten (item no)",
      "beschreibung": "Artikelbeschreibung, erste aussagekräftige Zeile(n)",
      "hersteller_nr": "Hersteller-Teilenummer (VPN/MPN), z.B. E431802",
      "ean": "EAN/UPC-Code, nur Ziffern",
      "menge_bestellt": 0,
      "menge_geliefert": 0,
      "seriennummern": ["nur die Seriennummern selbst, ohne 'SN:'-Präfix, exakt wie gedruckt"],
      "karton": "Karton-Nr / box no."
    }
  ]
}

Regeln:
- Alle Positionen auf allen Seiten erfassen.
- Seriennummern Zeichen für Zeichen exakt übernehmen, nichts ergänzen oder korrigieren. Zeilenumbrüche innerhalb der Liste ignorieren.
- Mengen als Zahlen. Fehlende Werte als leerer String bzw. leere Liste.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: prompt }] }]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API Fehler ' + response.status);
    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim();
    res.json({ success: true, data: JSON.parse(cleaned) });
  } catch (err) {
    console.error('extract-delivery error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────
// Datei als Anhang an ein InvenTree-Objekt hochladen (multipart)
// Header: X-INV-TOKEN   Body: { model_type, model_id, fileName, base64, contentType?, comment? }
// ────────────────────────────────────────────────────────
app.post('/inv-attach', async (req, res) => {
  const token = req.headers['x-inv-token'];
  const { model_type, model_id, fileName, base64, contentType, comment } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing X-INV-TOKEN header' });
  if (!model_type || !/^\d+$/.test(String(model_id || '')) || !fileName || !base64) {
    return res.status(400).json({ error: 'model_type, model_id, fileName und base64 sind erforderlich' });
  }
  const boundary = '----welcomeINV' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const asciiName = String(fileName).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(field('model_type', model_type) + field('model_id', String(model_id)) + field('comment', comment || ''), 'utf8'),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${asciiName}"\r\nContent-Type: ${contentType || 'application/pdf'}\r\n\r\n`, 'utf8'),
    Buffer.from(base64, 'base64'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  ]);
  try {
    const response = await fetch(INVENTREE_URL + '/api/attachment/', {
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + token,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        'Accept': 'application/json',
        'User-Agent': BROWSER_UA
      },
      body
    });
    const text = await response.text();
    try { return res.status(response.status).json(text ? JSON.parse(text) : {}); }
    catch (e) { return res.status(502).json({ error: 'InvenTree lieferte kein JSON', invStatus: response.status, preview: text.slice(0, 300) }); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
