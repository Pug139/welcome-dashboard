const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

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
app.use(express.static(path.join(__dirname, 'public')));

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
        'Content-Type': 'application/json'
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined
    });
    const data = await response.json();
    res.status(response.status).json(data);
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

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
