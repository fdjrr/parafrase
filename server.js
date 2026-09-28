#!/usr/bin/env node
// Parafrase lokal: server kecil tanpa dependensi (butuh Node 18+).
// Menyajikan index.html dan meneruskan teks ke endpoint yang kompatibel dengan OpenAI
// (default: Ollama di http://localhost:11434/v1).

const http = require('http');
const fs = require('fs');
const path = require('path');

// Muat file .env (opsional) tanpa menimpa variabel yang sudah diset dari luar.
// Format: NAMA=nilai, satu per baris. Komentar hanya di baris sendiri yang diawali #.
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
} catch {
  // tidak ada .env: pakai nilai bawaan
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const BASE = (process.env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.LLM_MODEL || 'qwen2.5:7b';
const API_KEY = process.env.LLM_API_KEY || 'ollama';
const MAX_CHARS = 20000;

const STYLES = {
  standard: 'Rewrite with different wording. Keep a neutral, natural tone.',
  formal: 'Rewrite in a formal, professional tone. Avoid slang and contractions.',
  simple: 'Rewrite in simple language: short sentences and everyday words.',
  shorten: 'Rewrite more concisely. Remove redundancy but keep every key point.',
  expand: 'Rewrite with slightly more detail and smoother transitions. Do not add new facts.',
};

const LEVELS = {
  1: { text: 'Change as little as possible: swap some words or phrases and keep the sentence structure.', temp: 0.3 },
  2: { text: 'Change a moderate amount: reword phrases and adjust some sentence structure.', temp: 0.6 },
  3: { text: 'Change a lot: restructure sentences and choose noticeably different wording.', temp: 0.8 },
};

function systemPrompt(style, level) {
  return [
    'You are a paraphrasing engine. Rewrite the text the user gives you between <text> tags.',
    'Rules:',
    '1. Output ONLY the rewritten text. No preface, notes, quotes, or markdown.',
    '2. Write in the same language as the input text.',
    '3. Keep the meaning. Do not add new facts, numbers, or claims.',
    '4. Keep placeholders such as {{1}} exactly as written.',
    '5. Keep paragraph breaks.',
    `Style: ${STYLES[style]}`,
    `Amount of change: ${LEVELS[level].text}`,
  ].join('\n');
}

const authHeaders = { Authorization: `Bearer ${API_KEY}` };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 200 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Teks terlalu besar.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function connectError(e) {
  if (e && e.cause && (e.cause.code === 'ECONNREFUSED' || e.cause.code === 'ENOTFOUND')) {
    return `Tidak bisa terhubung ke ${BASE}. Pastikan Ollama sudah berjalan.`;
  }
  return e && e.message ? e.message : 'Terjadi kesalahan.';
}

async function models(res) {
  try {
    const r = await fetch(`${BASE}/models`, { headers: authHeaders });
    if (!r.ok) throw new Error(`Daftar model gagal dimuat (${r.status}).`);
    const data = await r.json();
    const list = (data.data || []).map((m) => m.id).filter(Boolean);
    json(res, 200, { models: list, default: DEFAULT_MODEL });
  } catch (e) {
    json(res, 200, { models: [], default: DEFAULT_MODEL, error: connectError(e) });
  }
}

async function rephrase(req, res) {
  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { error: e.message || 'Permintaan tidak valid.' });
  }

  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const style = STYLES[input.mode] ? input.mode : 'standard';
  const level = LEVELS[input.level] ? Number(input.level) : 2;
  const model = typeof input.model === 'string' && input.model ? input.model : DEFAULT_MODEL;

  if (!text) return json(res, 400, { error: 'Teks kosong.' });
  if (text.length > MAX_CHARS) return json(res, 400, { error: `Maksimal ${MAX_CHARS} karakter per proses.` });

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  try {
    const upstream = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: LEVELS[level].temp,
        messages: [
          { role: 'system', content: systemPrompt(style, level) },
          { role: 'user', content: `<text>\n${text}\n</text>` },
        ],
      }),
      signal: ac.signal,
    });

    if (!upstream.ok) {
      const raw = await upstream.text();
      let msg = `Ollama membalas ${upstream.status}.`;
      try {
        const j = JSON.parse(raw);
        msg = (j.error && (j.error.message || j.error)) || msg;
      } catch {
        if (raw) msg = raw.slice(0, 300);
      }
      return json(res, 502, { error: String(msg) });
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (res.headersSent) return res.end();
    json(res, 502, { error: connectError(e) });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && pathname === '/api/models') return await models(res);
    if (req.method === 'POST' && pathname === '/api/rephrase') return await rephrase(req, res);
    json(res, 404, { error: 'Tidak ditemukan.' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Parafrase berjalan di http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Endpoint: ${BASE}  |  Model bawaan: ${DEFAULT_MODEL}`);
});
