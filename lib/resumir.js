// Resumen con la API de Claude (opcional: sin clave, la app prepara el texto para pegarlo en Claude)
const MODELS = {
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5 (recomendado)', in: 2, out: 10 },
  'claude-haiku-5-5': { name: 'Claude Haiku 5.5 (más barato)', in: 0.1, out: 0.5 },
  'claude-opus-5-5': { name: 'Claude Opus 5.5 (el más listo, más caro)', in: 4, out: 20 },
};
const DEFAULT_MODEL = 'claude-sonnet-5-5';

// Aproximación: en castellano, unos 3,5 caracteres por token
const estimateTokens = (chars) => Math.ceil(chars / 3.5);
function estimateCost(model, inTokens, outTokens = 2500) {
  const p = MODELS[model] || MODELS[DEFAULT_MODEL];
  return (inTokens * p.in + outTokens * p.out) / 1e6;
}

function buildPrompt({ channel, guild, fromTxt, toTxt, transcript, truncated }) {
  return `Te paso la conversación del canal #${channel}${guild ? ` del servidor de Discord "${guild}"` : ''} (una comunidad de streaming), desde el ${fromTxt} hasta el ${toTxt}.${truncated ? ' Ojo: es muy larga y solo están los mensajes más recientes de ese periodo.' : ''}
Cada línea es: [hora] Nombre: mensaje. "Nombre (a Otro)" significa que responde a Otro. Las líneas con guiones marcan el cambio de día.

Hazme un resumen en castellano de España, claro y fácil de leer, con este formato en Markdown:

## En pocas palabras
3 a 5 frases con lo más importante.

## Temas de los que se habló
Una viñeta por tema: de qué se habló, quién participó sobre todo y cuándo (día aproximado). Ordénalos de más a menos importante.

## Momentos destacados
Lo más gracioso, emotivo o llamativo. Puedes citar frases cortas entre comillas.

## Preguntas, peticiones e ideas para el directo
Lo que la comunidad pregunta, pide o propone (juegos, retos, horarios, sorteos…), con quién lo dijo.

## Cosas a vigilar
Discusiones, faltas de respeto, spam o algo que un moderador debería mirar. Si no hay nada, escribe "Nada que destacar".

## Ambiente
1 o 2 frases sobre el tono general de la comunidad.

Reglas: usa solo lo que aparece en la conversación, no inventes nada. Escribe los nombres tal cual. No hace falta repetir cada mensaje: agrupa y resume. Si la conversación es muy corta, haz el resumen corto.

<conversacion>
${transcript}
</conversacion>`;
}

async function summarize({ apiKey, model, prompt }) {
  model = MODELS[model] ? model : DEFAULT_MODEL;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5 * 60000);
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
    } catch (e) {
      lastErr = new Error(e.name === 'AbortError' ? 'Claude ha tardado demasiado en responder.' : 'No se puede conectar con Claude (' + e.message + ').');
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
      continue;
    }
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!text) throw new Error(j.stop_reason === 'refusal' ? 'Claude no ha querido resumir esta conversación.' : 'Claude ha devuelto un resumen vacío.');
      const u = j.usage || {};
      const p = MODELS[model];
      return {
        text, model, stopReason: j.stop_reason,
        usage: { input: u.input_tokens || 0, output: u.output_tokens || 0 },
        cost: ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out) / 1e6,
      };
    }
    const msg = (j.error && j.error.message) || '';
    if (r.status === 401) throw new Error('La clave de Claude no es válida. Revísala en Ajustes.');
    if (r.status === 400 && /credit|balance|billing/i.test(msg)) throw new Error('La cuenta de Claude no tiene saldo. Añade crédito en console.anthropic.com → Billing.');
    if (r.status === 400 || r.status === 404) throw new Error('Claude no ha aceptado la petición: ' + (msg || r.status));
    if (r.status === 403) throw new Error('La clave de Claude no tiene permiso para usar este modelo: ' + msg);
    // 429 (límite) o 5xx/529 (saturado): se reintenta
    lastErr = new Error(r.status === 429 ? 'Has llegado al límite de uso de Claude por ahora.' : 'Claude está saturado ahora mismo.');
    const wait = Number(r.headers.get('retry-after')) || 5 * (attempt + 1);
    await new Promise((res) => setTimeout(res, Math.min(60, wait) * 1000));
  }
  throw new Error((lastErr && lastErr.message) + ' Prueba otra vez en un rato.');
}

// Comprobar una clave sin gastar nada
async function checkKey(apiKey) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (r.status === 401) return { ok: false, error: 'La clave no es válida.' };
    return { ok: true };
  } catch (e) { return { ok: true, warn: 'No se ha podido comprobar ahora (' + e.message + '), pero se ha guardado.' }; }
}

module.exports = { MODELS, DEFAULT_MODEL, estimateTokens, estimateCost, buildPrompt, summarize, checkKey };
