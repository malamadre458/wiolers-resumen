// Lectura de Discord con el bot, SOLO por la API web (REST): no se "conecta" como la ruleta,
// así que las dos apps pueden usar el mismo bot a la vez sin molestarse.
const API = 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://github.com/axfl/wiolers-resumen, 1.0)';
const DISCORD_EPOCH = 1420070400000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errores de Discord explicados en castellano
function explain(status, code, where) {
  if (status === 401) return 'El token del bot no es válido. Cópialo otra vez (mira el apartado "Bot" del README).';
  if (code === 50001) return `El bot no puede ver ${where}. En Discord: ajustes del canal → Permisos → añade el bot con "Ver canal" y "Leer el historial de mensajes".`;
  if (code === 50013) return `Al bot le falta el permiso "Leer el historial de mensajes" en ${where}.`;
  if (code === 10003) return 'Ese canal ya no existe.';
  if (status === 403) return `El bot no tiene permiso para ${where}.`;
  return `Discord ha respondido con un error (${status}${code ? ' · código ' + code : ''}).`;
}

function createDiscord(getToken) {
  async function api(path, where = 'ese canal') {
    const token = getToken();
    if (!token) { const e = new Error('Falta el token del bot.'); e.status = 401; throw e; }
    let lastErr;
    for (let attempt = 0; attempt < 8; attempt++) {
      let r;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        r = await fetch(API + path, { headers: { Authorization: 'Bot ' + token, 'User-Agent': UA }, signal: ctrl.signal }).finally(() => clearTimeout(t));
      } catch (e) { // sin conexión o sin respuesta: se reintenta
        lastErr = e; await sleep(1000 * (attempt + 1)); continue;
      }
      if (r.status === 429) { // límite de Discord: espera lo que diga y sigue
        const j = await r.json().catch(() => ({}));
        await sleep(Math.min(60, Number(j.retry_after) || Number(r.headers.get('retry-after')) || 1) * 1000 + 150);
        continue;
      }
      if (r.status >= 500) { lastErr = new Error('Discord no responde (' + r.status + ')'); await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const e = new Error(explain(r.status, j.code, where)); e.status = r.status; e.code = j.code; throw e;
      }
      // Si ya no quedan peticiones en este momento, se espera antes de la siguiente
      if (r.headers.get('x-ratelimit-remaining') === '0') {
        const ra = parseFloat(r.headers.get('x-ratelimit-reset-after') || '1');
        await sleep(Math.min(60, ra) * 1000 + 50);
      }
      return r.json();
    }
    throw new Error('No se puede conectar con Discord ahora mismo' + (lastErr ? ' (' + lastErr.message + ')' : '') + '. Prueba en un rato.');
  }

  // Bot, servidores y canales de texto
  const me = () => api('/users/@me', 'tu bot');
  async function channels() {
    const guilds = await api('/users/@me/guilds', 'tus servidores');
    const out = [];
    for (const g of guilds) {
      let list = [];
      try { list = await api(`/guilds/${g.id}/channels`, 'los canales de ' + g.name); } catch { continue; }
      for (const c of list) {
        if (c.type !== 0 && c.type !== 5) continue; // texto y anuncios
        out.push({ id: c.id, name: c.name, guild: g.name, guildId: g.id, pos: c.position || 0, parent: c.parent_id || null });
      }
    }
    out.sort((a, b) => a.guild.localeCompare(b.guild) || a.pos - b.pos);
    return out;
  }
  async function channelInfo(id) {
    const c = await api(`/channels/${id}`, 'ese canal');
    let roles = [], chans = [];
    if (c.guild_id) {
      roles = await api(`/guilds/${c.guild_id}/roles`, 'los roles del servidor').catch(() => []);
      chans = await api(`/guilds/${c.guild_id}/channels`, 'los canales del servidor').catch(() => []);
    }
    return { id: c.id, name: c.name, guildId: c.guild_id, roles, chans };
  }

  // Lee los mensajes entre dos fechas, del más nuevo al más antiguo (100 en cada petición)
  async function readMessages({ channelId, from, to, max = 20000, onProgress, isCancelled }) {
    const toSnowflake = (ms) => ((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n).toString();
    let before = to ? toSnowflake(to + 1) : null;
    const msgs = [];
    let truncated = false;
    for (;;) {
      if (isCancelled && isCancelled()) throw new Error('Cancelado.');
      const page = await api(`/channels/${channelId}/messages?limit=100${before ? '&before=' + before : ''}`, 'ese canal');
      if (!page.length) break;
      let reachedStart = false;
      for (const m of page) {
        const ts = Date.parse(m.timestamp);
        if (ts < from) { reachedStart = true; continue; }
        if (to && ts > to) continue;
        msgs.push(m);
      }
      before = page[page.length - 1].id;
      const oldest = Date.parse(page[page.length - 1].timestamp);
      if (onProgress) onProgress(msgs.length, oldest);
      if (reachedStart || page.length < 100) break;
      if (msgs.length >= max) { truncated = true; break; }
    }
    msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return { msgs, truncated };
  }

  return { api, me, channels, channelInfo, readMessages };
}

// ---------- Convertir los mensajes en una conversación legible ----------
const TYPE_TEXT = {
  6: 'ha fijado un mensaje', 7: 'ha entrado al servidor', 8: 'ha mejorado el servidor (boost)',
  9: 'ha mejorado el servidor (boost)', 10: 'ha mejorado el servidor (boost)', 11: 'ha mejorado el servidor (boost)',
  18: 'ha creado un hilo', 46: 'ha creado una encuesta',
};
const nameOf = (u) => (u && (u.global_name || u.username)) || 'alguien';

function attachmentsText(m) {
  const out = [];
  for (const a of m.attachments || []) {
    const t = String(a.content_type || '');
    out.push(t.startsWith('image/') ? '[imagen]' : t.startsWith('video/') ? '[vídeo]' : t.startsWith('audio/') ? '[audio]' : '[archivo]');
  }
  for (const s of m.sticker_items || []) out.push(`[sticker: ${s.name}]`);
  if (m.poll && m.poll.question) out.push(`[encuesta: ${m.poll.question.text || ''}]`);
  return out;
}

function cleanContent(text, m, info) {
  const users = new Map((m.mentions || []).map((u) => [u.id, nameOf(u)]));
  const roles = new Map((info.roles || []).map((r) => [r.id, r.name]));
  const chans = new Map((info.chans || []).map((c) => [c.id, c.name]));
  return String(text || '')
    .replace(/<@!?(\d+)>/g, (_, id) => '@' + (users.get(id) || 'usuario'))
    .replace(/<@&(\d+)>/g, (_, id) => '@' + (roles.get(id) || 'rol'))
    .replace(/<#(\d+)>/g, (_, id) => '#' + (chans.get(id) || 'canal'))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(:[a-zA-Z])?>/g, (_, s) => new Date(+s * 1000).toLocaleString('es-ES'))
    .replace(/\s*\n\s*/g, ' / ')
    .trim();
}

// Texto compacto: una línea por mensaje, agrupado por días, con la hora local
function toTranscript(msgs, info, { tz = 'Europe/Madrid', includeBots = false } = {}) {
  const dayFmt = new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const lines = [];
  const kept = [];
  let lastDay = '';
  for (const m of msgs) {
    if (!includeBots && m.author && m.author.bot) continue;
    const d = new Date(m.timestamp);
    const day = dayFmt.format(d);
    const who = nameOf(m.author);
    let text;
    if (TYPE_TEXT[m.type]) text = `(${who} ${TYPE_TEXT[m.type]})`;
    else if (m.type !== 0 && m.type !== 19 && m.type !== 20 && m.type !== 23) continue; // otros avisos del sistema
    else {
      let body = cleanContent(m.content, m, info);
      const snap = m.message_snapshots && m.message_snapshots[0] && m.message_snapshots[0].message;
      if (!body && snap) body = '(reenviado) ' + cleanContent(snap.content, snap, info);
      const extra = attachmentsText(m);
      body = [body, ...extra].filter(Boolean).join(' ');
      if (!body && m.embeds && m.embeds.length) body = '[enlace o tarjeta: ' + (m.embeds[0].title || m.embeds[0].url || '') + ']';
      if (!body) continue;
      const replyTo = m.type === 19 && m.referenced_message ? ` (a ${nameOf(m.referenced_message.author)})` : '';
      text = `${who}${replyTo}: ${body}`;
    }
    if (day !== lastDay) { lines.push('', `— ${day} —`); lastDay = day; }
    lines.push(`[${timeFmt.format(d)}] ${text}`);
    kept.push(m);
  }
  return { text: lines.join('\n').trim(), kept };
}

// Datos exactos (no los calcula la IA): quién habló más, días, enlaces…
function stats(kept, { tz = 'Europe/Madrid' } = {}) {
  const dayKey = new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  const hourKey = new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' });
  const people = new Map(), days = new Map(), hours = new Map(), links = new Map();
  let emptyContent = 0, real = 0;
  for (const m of kept) {
    if (m.type !== 0 && m.type !== 19) continue;
    real++;
    if (!m.content && !(m.attachments || []).length && !(m.sticker_items || []).length && !(m.embeds || []).length && !m.message_snapshots) emptyContent++;
    const who = nameOf(m.author);
    people.set(who, (people.get(who) || 0) + 1);
    const d = new Date(m.timestamp);
    const dk = dayKey.format(d); days.set(dk, (days.get(dk) || 0) + 1);
    const hk = hourKey.format(d); hours.set(hk, (hours.get(hk) || 0) + 1);
    for (const u of String(m.content || '').match(/https?:\/\/[^\s<>()]+/g) || []) {
      const url = u.replace(/[.,!?;:]+$/, '');
      if (!links.has(url)) links.set(url, { url, who, n: 0 });
      links.get(url).n++;
    }
  }
  const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
  const busiestHour = top(hours, 1)[0];
  return {
    messages: real,
    people: people.size,
    topPeople: top(people, 10),
    days: [...days].map(([k, v]) => ({ k, v })),
    busiestDay: top(days, 1)[0] || null,
    busiestHour: busiestHour ? { k: busiestHour.k + ':00', v: busiestHour.v } : null,
    links: [...links.values()].slice(0, 30),
    // Si casi todos los mensajes llegan vacíos, al bot le falta "Message Content Intent"
    contentMissing: real >= 5 && emptyContent / real > 0.8,
  };
}

module.exports = { createDiscord, toTranscript, stats };
