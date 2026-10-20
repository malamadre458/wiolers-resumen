// Resumen de Discord — app aparte de la del directo (hecho por AXFL)
// Lee un canal de Discord con el mismo bot de la ruleta (solo lectura) y hace un resumen desde la fecha que elijas.
// Sin librerías externas: solo Node.js (versión 20 o superior).
//   En tu ordenador: npm start → http://localhost:3020
//   Online (Railway): variables PANEL_PASSWORD (obligatoria), DISCORD_TOKEN y, si quieres el resumen automático, ANTHROPIC_API_KEY
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDiscord, toTranscript, stats } = require('./lib/discord');
const R = require('./lib/resumir');

// ---------- Configuración ----------
loadDotEnv(path.join(__dirname, '.env'));
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const ONLINE = !!(env('RAILWAY_PROJECT_ID') || env('RAILWAY_SERVICE_ID') || env('RAILWAY_ENVIRONMENT_NAME') || env('RAILWAY_ENVIRONMENT')
  || env('RENDER') || env('FLY_APP_NAME') || env('ONLINE') === '1');
const PORT = Number(env('PORT')) || 3020;
const HOST = env('HOST') || (ONLINE ? '0.0.0.0' : '127.0.0.1');
const PASSWORD = env('PANEL_PASSWORD');
const TZ = env('ZONA_HORARIA') || 'Europe/Madrid';
const PERSIST_DIR = env('DATA_DIR') || env('RAILWAY_VOLUME_MOUNT_PATH');
const DATA_DIR = path.resolve(PERSIST_DIR || path.join(__dirname, 'datos'));
const SUM_DIR = path.join(DATA_DIR, 'resumenes');
fs.mkdirSync(SUM_DIR, { recursive: true });
const MAX_MESSAGES = Math.max(100, Number(env('MAX_MENSAJES')) || 20000);

function loadDotEnv(file) { // .env sencillo (solo en tu ordenador)
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o, null, 2)); fs.renameSync(tmp, f); };

const SECRET_FILE = path.join(DATA_DIR, 'secretos.json');
const secrets = readJSON(SECRET_FILE, {});
if (!secrets.sessionSalt) { secrets.sessionSalt = crypto.randomBytes(24).toString('hex'); try { writeJSON(SECRET_FILE, secrets); } catch (e) { console.error('No se pudo guardar secretos.json:', e.message); } }

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
let config = readJSON(CONFIG_FILE, {});
const saveConfig = () => writeJSON(CONFIG_FILE, config);
const discordToken = () => env('DISCORD_TOKEN') || config.discordToken || '';
const anthropicKey = () => env('ANTHROPIC_API_KEY') || config.anthropicKey || '';
const model = () => (R.MODELS[env('RESUMEN_MODELO')] ? env('RESUMEN_MODELO') : R.MODELS[config.model] ? config.model : R.DEFAULT_MODEL);
const discord = createDiscord(discordToken);

// ---------- Contraseña (igual que en la app del directo) ----------
const AUTH_ON = !!PASSWORD;
const LOCKED = ONLINE && !PASSWORD;
const signKey = crypto.createHash('sha256').update(PASSWORD + '|' + secrets.sessionSalt).digest();
const COOKIE = 'resumen_sesion';
const SESSION_DAYS = 30;
const makeToken = () => { const ts = Date.now().toString(36); return ts + '.' + crypto.createHmac('sha256', signKey).update(ts).digest('base64url'); };
function validToken(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const [ts, sig] = tok.split('.');
  if (!ts || !sig) return false;
  const good = crypto.createHmac('sha256', signKey).update(ts).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  const age = Date.now() - parseInt(ts, 36);
  return age >= 0 && age < SESSION_DAYS * 864e5;
}
function cookieOf(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } }
  }
  return null;
}
const isAdmin = (req) => !LOCKED && (!AUTH_ON || validToken(cookieOf(req.headers.cookie, COOKIE)));
const safeNext = (n) => { n = String(n || '/'); return /^\/(?![\/\\])[^\s]*$/.test(n) ? n : '/'; };
const fails = new Map();
let globalFails = [], globalUntil = 0;
const clientIp = (req) => (ONLINE && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'x';

// ---------- Utilidades HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...extra });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
const redirect = (res, to, extra = {}) => { res.writeHead(302, { Location: to, ...extra }); res.end(); };
function sendFile(res, file, extra = {}) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'No encontrado');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream', extra);
  });
}
function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = String(req.headers['content-type'] || '');
      try {
        if (ct.includes('application/json')) resolve(raw ? JSON.parse(raw) : {});
        else if (ct.includes('application/x-www-form-urlencoded')) resolve(Object.fromEntries(new URLSearchParams(raw)));
        else resolve({});
      } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}
const PUB = (f) => path.join(__dirname, 'public', f);
function lockedPage(res) {
  send(res, 503, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Falta la contraseña</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font:600 16px system-ui;background:#f3eefe;color:#3b2a7a;padding:16px">
<div style="max-width:520px;background:#fff;border:4px solid #6d4fd0;border-radius:24px;padding:26px"><h2 style="margin-top:0">Falta la contraseña</h2>
<p>La app está online pero no tiene contraseña, así que está bloqueada.</p><p>En Railway: tu servicio → <b>Variables</b> → <b>New Variable</b> → <code>PANEL_PASSWORD</code> con la contraseña que quieras.</p></div>`);
}

// ---------- Resúmenes guardados ----------
const recFile = (id) => path.join(SUM_DIR, id + '.json');
const txtFile = (id) => path.join(SUM_DIR, id + '.txt');
const validId = (id) => /^[a-z0-9-]{6,40}$/.test(String(id || ''));
function listRecords() {
  let files = [];
  try { files = fs.readdirSync(SUM_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => readJSON(path.join(SUM_DIR, f), null)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}
function pruneRecords(keep = 40) {
  for (const r of listRecords().slice(keep)) { try { fs.unlinkSync(recFile(r.id)); fs.unlinkSync(txtFile(r.id)); } catch {} }
}
const fmtDate = (ms) => new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

// ---------- Trabajo en curso (uno a la vez) ----------
let job = null; // { id, phase, count, oldest, from, to, error, recordId, cancelled }
const jobPublic = () => job && { id: job.id, phase: job.phase, count: job.count, oldest: job.oldest, from: job.from, to: job.to, error: job.error, recordId: job.recordId, startedAt: job.startedAt };
const busy = () => job && (job.phase === 'leyendo' || job.phase === 'resumiendo');

async function runRead({ channelId, from, to, includeBots }) {
  const j = job;
  try {
    const info = await discord.channelInfo(channelId);
    j.channelName = info.name;
    const guildName = (channelsCache.list || []).find((c) => c.id === channelId)?.guild || '';
    const { msgs, truncated } = await discord.readMessages({
      channelId, from, to, max: MAX_MESSAGES,
      onProgress: (n, oldest) => { j.count = n; j.oldest = oldest; },
      isCancelled: () => j.cancelled,
    });
    const { text, kept } = toTranscript(msgs, info, { tz: TZ, includeBots });
    const st = stats(kept, { tz: TZ });
    const id = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex');
    const rec = {
      id, createdAt: Date.now(), channelId, channel: info.name, guild: guildName, from, to, includeBots,
      fromTxt: fmtDate(from), toTxt: fmtDate(to), truncated, stats: st, chars: text.length,
      estimate: { tokens: R.estimateTokens(text.length + 2500), cost: R.estimateCost(model(), R.estimateTokens(text.length + 2500)), model: model() },
      summary: null,
    };
    fs.writeFileSync(txtFile(id), text);
    writeJSON(recFile(id), rec);
    pruneRecords();
    config.lastChannelId = channelId; try { saveConfig(); } catch {}
    j.recordId = id; j.count = st.messages; j.phase = 'leido';
    console.log(`📥 Leídos ${st.messages} mensajes de #${info.name} (${rec.fromTxt} → ${rec.toTxt})`);
  } catch (e) {
    j.phase = 'error'; j.error = e.message;
    console.log('❌ Error leyendo Discord:', e.message);
  }
}

async function runSummary(recordId) {
  const j = job;
  try {
    const rec = readJSON(recFile(recordId), null);
    if (!rec) throw new Error('No se encuentra esa conversación.');
    const transcript = fs.readFileSync(txtFile(recordId), 'utf8');
    if (!transcript.trim()) throw new Error('No hay mensajes en esas fechas.');
    const prompt = R.buildPrompt({ channel: rec.channel, guild: rec.guild, fromTxt: rec.fromTxt, toTxt: rec.toTxt, transcript, truncated: rec.truncated });
    const out = await R.summarize({ apiKey: anthropicKey(), model: model(), prompt });
    rec.summary = { text: out.text, model: out.model, usage: out.usage, cost: out.cost, at: Date.now(), cut: out.stopReason === 'max_tokens' };
    writeJSON(recFile(recordId), rec);
    j.phase = 'hecho';
    console.log(`✨ Resumen hecho (${out.usage.input} + ${out.usage.output} tokens, ~${out.cost.toFixed(3)} $)`);
  } catch (e) {
    j.phase = 'error'; j.error = e.message;
    console.log('❌ Error resumiendo:', e.message);
  }
}

// Canales (se guardan 2 min para no preguntar a Discord cada vez)
const channelsCache = { at: 0, list: null };
async function getChannels(force) {
  if (!force && channelsCache.list && Date.now() - channelsCache.at < 120000) return channelsCache.list;
  channelsCache.list = await discord.channels();
  channelsCache.at = Date.now();
  return channelsCache.list;
}
let botCache = { at: 0, data: null };
async function botInfo(force) {
  if (!discordToken()) return { ok: false, error: 'Falta el token del bot.' };
  if (!force && botCache.data && Date.now() - botCache.at < 300000) return botCache.data;
  try { const u = await discord.me(); botCache.data = { ok: true, name: u.global_name || u.username }; }
  catch (e) { botCache.data = { ok: false, error: e.message }; }
  botCache.at = Date.now();
  return botCache.data;
}

// ---------- Rutas ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const M = req.method;

  // Archivos públicos
  if (M === 'GET' && p === '/estilos.css') return sendFile(res, PUB('estilos.css'));
  if (M === 'GET' && p.startsWith('/fuentes/')) {
    const f = p.slice(9);
    if (!['fuentes.css', 'Fredoka.woff', 'Nunito.woff'].includes(f)) return send(res, 404, 'No encontrado');
    return sendFile(res, PUB('fuentes/' + f), { 'Cache-Control': 'public, max-age=604800' });
  }
  if (M === 'GET' && p === '/favicon.ico') return send(res, 204, '');

  // Entrar / salir
  if (p === '/entrar') {
    if (LOCKED) return lockedPage(res);
    if (M === 'GET') return isAdmin(req) ? redirect(res, safeNext(url.searchParams.get('next'))) : sendFile(res, PUB('entrar.html'));
    if (M === 'POST') {
      const b = await readBody(req, 10 * 1024).catch(() => ({}));
      const next = safeNext(b.next);
      const ip = clientIp(req);
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (f.until > Date.now() || globalUntil > Date.now()) return redirect(res, '/entrar?error=espera&next=' + encodeURIComponent(next));
      const given = String(b.password || '');
      const ok = AUTH_ON && given.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PASSWORD));
      if (!ok) {
        f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60e3; f.n = 0; }
        fails.set(ip, f); if (fails.size > 5000) fails.clear();
        const now = Date.now(); globalFails = globalFails.filter((t) => now - t < 10 * 60e3); globalFails.push(now);
        if (globalFails.length > 20) { globalUntil = now + 60e3; globalFails = []; }
        return setTimeout(() => redirect(res, '/entrar?error=1&next=' + encodeURIComponent(next)), 600);
      }
      fails.delete(ip);
      const secure = String(req.headers['x-forwarded-proto'] || '').startsWith('https');
      return redirect(res, next, { 'Set-Cookie': `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}` });
    }
  }
  if (p === '/salir' && M === 'POST') return redirect(res, '/entrar', { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });

  // A partir de aquí, todo necesita sesión
  if (LOCKED) return p.startsWith('/api/') ? json(res, 503, { ok: false, error: 'falta PANEL_PASSWORD' }) : lockedPage(res);
  if (!isAdmin(req)) {
    if (p.startsWith('/api/')) return json(res, 401, { ok: false, error: 'sesión caducada, vuelve a entrar' });
    return redirect(res, '/entrar?next=' + encodeURIComponent(p + url.search));
  }

  if (M === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, PUB('index.html'), { 'Cache-Control': 'no-store' });

  if (M === 'GET' && p === '/api/estado') {
    const bot = await botInfo(url.searchParams.has('recargar'));
    return json(res, 200, {
      ok: true, online: ONLINE, auth: AUTH_ON, persistent: !ONLINE || !!PERSIST_DIR, tz: TZ,
      bot, tokenSet: !!discordToken(), tokenFromEnv: !!env('DISCORD_TOKEN'),
      keySet: !!anthropicKey(), keyFromEnv: !!env('ANTHROPIC_API_KEY'),
      model: model(), modelFromEnv: !!R.MODELS[env('RESUMEN_MODELO')],
      models: Object.entries(R.MODELS).map(([id, m]) => ({ id, name: m.name })),
      lastChannelId: config.lastChannelId || null, maxMessages: MAX_MESSAGES, job: jobPublic(),
    });
  }

  if (M === 'GET' && p === '/api/canales') {
    try {
      const list = await getChannels(url.searchParams.has('recargar'));
      const general = list.find((c) => c.name === 'general') || list.find((c) => /general/i.test(c.name));
      return json(res, 200, { ok: true, channels: list, defaultId: config.lastChannelId && list.some((c) => c.id === config.lastChannelId) ? config.lastChannelId : general ? general.id : (list[0] && list[0].id) || null });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  if (M === 'POST' && p === '/api/ajustes') {
    const b = await readBody(req).catch(() => ({}));
    const msgs = [];
    if (typeof b.discordToken === 'string' && b.discordToken.trim()) {
      const tok = b.discordToken.trim().replace(/^Bot\s+/i, '').replace(/^["']|["']$/g, '');
      const prev = config.discordToken;
      config.discordToken = tok;
      botCache = { at: 0, data: null }; channelsCache.list = null;
      const bot = await botInfo(true);
      if (!bot.ok && !env('DISCORD_TOKEN')) { config.discordToken = prev; botCache = { at: 0, data: null }; return json(res, 200, { ok: false, error: bot.error }); }
      msgs.push(`Bot conectado: ${bot.name || 'ok'}`);
    }
    if (typeof b.anthropicKey === 'string' && b.anthropicKey.trim()) {
      const key = b.anthropicKey.trim();
      const chk = await R.checkKey(key);
      if (!chk.ok) return json(res, 200, { ok: false, error: 'Clave de Claude: ' + chk.error });
      config.anthropicKey = key;
      msgs.push(chk.warn || 'Clave de Claude guardada');
    }
    if (b.quitarClave) { delete config.anthropicKey; msgs.push('Clave de Claude quitada'); }
    if (typeof b.model === 'string' && R.MODELS[b.model]) config.model = b.model;
    try { saveConfig(); } catch (e) { return json(res, 500, { ok: false, error: 'No se pudo guardar: ' + e.message }); }
    return json(res, 200, { ok: true, msg: msgs.join(' · ') || 'Guardado' });
  }

  if (M === 'POST' && p === '/api/leer') {
    if (busy()) return json(res, 409, { ok: false, error: 'Ya hay una lectura o un resumen en marcha.', job: jobPublic() });
    const b = await readBody(req).catch(() => ({}));
    const channelId = String(b.channelId || '');
    const from = Number(b.from), to = Number(b.to) || Date.now();
    if (!/^\d{1,30}$/.test(channelId)) return json(res, 400, { ok: false, error: 'Elige un canal.' });
    if (!Number.isFinite(from) || from <= 1420070400000) return json(res, 400, { ok: false, error: 'Elige la fecha de inicio.' });
    if (from >= to) return json(res, 400, { ok: false, error: 'La fecha "desde" tiene que ser anterior a "hasta".' });
    if (!discordToken()) return json(res, 400, { ok: false, error: 'Falta el token del bot (Ajustes).' });
    job = { id: crypto.randomBytes(4).toString('hex'), phase: 'leyendo', count: 0, oldest: to, from, to: Math.min(to, Date.now()), startedAt: Date.now() };
    runRead({ channelId, from, to: job.to, includeBots: !!b.includeBots });
    return json(res, 200, { ok: true, job: jobPublic() });
  }

  if (M === 'POST' && p === '/api/resumir') {
    if (busy()) return json(res, 409, { ok: false, error: 'Ya hay una lectura o un resumen en marcha.', job: jobPublic() });
    const b = await readBody(req).catch(() => ({}));
    if (!validId(b.id)) return json(res, 400, { ok: false, error: 'Falta la conversación.' });
    if (!anthropicKey()) return json(res, 400, { ok: false, error: 'Falta la clave de Claude (Ajustes). Mientras, usa "Copiar para Claude".' });
    job = { id: crypto.randomBytes(4).toString('hex'), phase: 'resumiendo', count: 0, recordId: b.id, startedAt: Date.now() };
    runSummary(b.id);
    return json(res, 200, { ok: true, job: jobPublic() });
  }

  if (M === 'GET' && p === '/api/trabajo') return json(res, 200, { ok: true, job: jobPublic() });
  if (M === 'POST' && p === '/api/trabajo/cancelar') { if (job && job.phase === 'leyendo') job.cancelled = true; return json(res, 200, { ok: true }); }

  if (M === 'GET' && p === '/api/resumenes') {
    return json(res, 200, { ok: true, items: listRecords().map((r) => ({ id: r.id, createdAt: r.createdAt, channel: r.channel, guild: r.guild, fromTxt: r.fromTxt, toTxt: r.toTxt, messages: r.stats.messages, hasSummary: !!r.summary })) });
  }
  const m = p.match(/^\/api\/resumenes\/([a-z0-9-]+)(\/conversacion\.txt|\/para-claude\.txt)?$/);
  if (m && validId(m[1])) {
    const rec = readJSON(recFile(m[1]), null);
    if (!rec) return json(res, 404, { ok: false, error: 'No existe.' });
    if (M === 'DELETE' && !m[2]) { try { fs.unlinkSync(recFile(m[1])); fs.unlinkSync(txtFile(m[1])); } catch {} return json(res, 200, { ok: true }); }
    if (M !== 'GET') return json(res, 405, { ok: false });
    if (!m[2]) return json(res, 200, { ok: true, item: rec });
    let text = ''; try { text = fs.readFileSync(txtFile(m[1]), 'utf8'); } catch {}
    const base = `discord-${rec.channel}-${rec.id.slice(0, 10)}`.replace(/[^\w.-]+/g, '-');
    if (m[2] === '/conversacion.txt') {
      const head = `Conversación de #${rec.channel}${rec.guild ? ' (' + rec.guild + ')' : ''} · del ${rec.fromTxt} al ${rec.toTxt} · ${rec.stats.messages} mensajes\n\n`;
      return send(res, 200, '﻿' + head + text, 'text/plain; charset=utf-8', { 'Content-Disposition': `attachment; filename="${base}.txt"` });
    }
    const prompt = R.buildPrompt({ channel: rec.channel, guild: rec.guild, fromTxt: rec.fromTxt, toTxt: rec.toTxt, transcript: text, truncated: rec.truncated });
    return send(res, 200, prompt, 'text/plain; charset=utf-8', { 'Content-Disposition': `attachment; filename="${base}-para-claude.txt"` });
  }

  if (p.startsWith('/api/')) return json(res, 404, { ok: false, error: 'No existe.' });
  return send(res, 404, '<meta charset="utf-8"><p style="font:16px system-ui;padding:20px">No existe esta página. <a href="/">Ir al inicio</a></p>');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('Error:', e);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Error inesperado: ' + e.message });
  });
});
process.on('unhandledRejection', (e) => console.error('⚠️  Error no controlado:', (e && e.stack) || e));
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`\n❌ El puerto ${PORT} ya está en uso. Cierra la otra ventana o pon PORT=3030 en el archivo .env.\n`); process.exit(1); }
  throw e;
});
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  💜 Resumen de Discord — hecho por AXFL');
  console.log(`  Abre: ${ONLINE ? '(tu URL pública)' : 'http://localhost:' + PORT}`);
  console.log(`  Datos guardados en: ${DATA_DIR}`);
  if (LOCKED) console.log('\n  ⚠️  Falta PANEL_PASSWORD: la app está bloqueada hasta que la pongas en las variables.');
  else if (!AUTH_ON) console.log('  (Sin contraseña: solo se puede abrir desde este ordenador)');
  if (ONLINE && !PERSIST_DIR) console.log('  ⚠️  Sin volumen: los ajustes y resúmenes se borran al actualizar. En Railway añade un volumen (Mount path: /data).');
  if (!discordToken()) console.log('  Falta el token del bot: ponlo en DISCORD_TOKEN o pégalo en la app (Ajustes).');
  console.log('');
});
