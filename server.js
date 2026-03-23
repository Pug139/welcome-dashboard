const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

// CORS + Teams iframe headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-OP-URL, X-OP-KEY');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Allow embedding in Teams/SharePoint
  res.header('X-Frame-Options', 'ALLOWALL');
  res.header('Content-Security-Policy', "frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com https://*.sharepoint.com https://*.office.com");
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve dashboard HTML
app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint for OpenProject API
app.get('/proxy/*', async (req, res) => {
  const opUrl = req.headers['x-op-url'];
  const opKey = req.headers['x-op-key'];
  if (!opUrl || !opKey) return res.status(400).json({ error: 'Missing headers' });

  const apiPath = req.url.replace('/proxy', '/api/v3');
  const targetUrl = opUrl.replace(/\/$/, '') + apiPath;

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from('apikey:' + opKey).toString('base64'),
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
