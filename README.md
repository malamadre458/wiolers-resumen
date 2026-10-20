# Resumen de Discord — AXFL

App **aparte** de la del directo (MultiChat + Ruleta). Lee un canal de Discord (por defecto **#general**) con **el mismo bot de la ruleta** y te hace un resumen de lo que se ha hablado desde la fecha que elijas:

- En pocas palabras, temas, momentos destacados, preguntas e ideas para el directo, cosas a vigilar y ambiente.
- Datos exactos: número de mensajes, quién habló más, día con más charla, hora punta y enlaces compartidos.
- Historial con los últimos 40 resúmenes.
- Botones para copiar el resumen, descargar la conversación o copiarla para pegarla en Claude.

El bot **solo lee**: no escribe nada en Discord ni se conecta como la ruleta, así que las dos apps pueden usar el mismo bot a la vez.
Esta app **no toca nada** de la app del directo: tiene su propio repositorio, su propio servicio en Railway y su propia contraseña.

---

## 1. El token del bot (sin romper la ruleta)

Necesitas el token del bot que ya usáis en la ruleta. **No pulses "Reset Token"** en Discord: si lo haces, la ruleta se desconecta.

Dónde encontrarlo en tu Mac:
- En la carpeta antigua **ruleta-discord**: abre el archivo **config.json** o **.env** con TextEdit y copia el valor de `token` / `DISCORD_TOKEN`.
  (Los archivos que empiezan por punto están ocultos: en Finder pulsa `⌘ + Mayúsculas + .` para verlos).
- O en la carpeta **wiolers-directo → datos → ruleta-config.json**, si alguna vez la abriste en tu ordenador con el bot conectado.

Si no lo encuentras: Discord Developer Portal → tu app → **Bot** → **Reset Token** → cópialo y pégalo **en las dos apps**. En la ruleta: "Conexión con Discord" → **Cambiar**.

## 2. Subirla a GitHub (repositorio nuevo)

1. Entra en https://github.com/new
2. Nombre: `wiolers-resumen`. Marca **Private**. Pulsa **Create repository**.
3. Pulsa **uploading an existing file**, arrastra **todo lo que hay dentro** de la carpeta `wiolers-resumen` y pulsa **Commit changes**.

## 3. Crear el servicio en Railway (en el mismo proyecto, sin tocar el otro)

1. Abre tu proyecto en Railway → botón **+ Create** (o **New**) → **GitHub Repo** → elige `wiolers-resumen`.
   Si no aparece: **Configure GitHub App** y dale acceso a ese repositorio.
2. Haz clic en el servicio nuevo → **Variables** → añade:
   - `PANEL_PASSWORD` → la contraseña que quieras (obligatoria).
   - `DISCORD_TOKEN` → el token del bot (o pégalo luego en la app, en ⚙ Ajustes).
   - `ANTHROPIC_API_KEY` → opcional, ver el apartado 5.
3. **Volumen** (para que no se borren los ajustes ni el historial al actualizar): clic derecho en el lienzo → **Volume** → elige `wiolers-resumen` → Mount path `/data`.
4. **Settings → Networking → Generate Domain**. Esa es la dirección de la app.

## 4. Usarla

1. Abre la dirección y entra con la contraseña.
2. Elige el canal (sale **#general** por defecto) y la fecha **Desde**. **Hasta** vacío significa "hasta ahora".
   Atajos: últimas 24 h, 3 días, 1 semana o **desde el último resumen**.
3. Pulsa **Hacer resumen**.

Si el bot no ve un canal, la app te dice qué permiso falta. En Discord: ajustes del canal → Permisos → añade el bot con **Ver canal** y **Leer el historial de mensajes**.

## 5. Resumen automático con Claude (opcional)

- **Sin clave**: la app lee los mensajes y te los prepara. Pulsa **Copiar para Claude** y pégalo en Claude. Si es muy largo, usa **Descargar conversación** y adjunta el archivo.
- **Con clave**: el resumen sale directamente en la app.
  1. https://console.anthropic.com → crea una cuenta.
  2. **Billing**: añade unos euros de crédito.
  3. **API Keys** → **Create Key** → copia la clave (empieza por `sk-ant-`).
  4. Ponla en Railway como `ANTHROPIC_API_KEY`, o pégala en la app en ⚙ Ajustes.

Coste aproximado con Claude Sonnet 5.5 (el recomendado): una semana de un canal con unos 1.600 mensajes cuesta unos 4 céntimos. La app enseña el coste aproximado de cada resumen. En ⚙ Ajustes puedes elegir **Haiku** (más barato) u **Opus** (más fino, más caro).
Al resumir con clave, la conversación se envía a la API de Claude (Anthropic) para escribir el resumen.

## Usarla en tu ordenador

| Sistema | Qué hacer |
|---|---|
| Mac | Doble clic en `INICIAR-Mac.command` (la primera vez: clic derecho → Abrir) |
| Windows | Doble clic en `INICIAR-Windows.bat` |

Se abre en `http://localhost:3020` (la del directo usa el 3010). No hace falta instalar nada más que Node.js. En tu ordenador no pide contraseña. Puedes poner el token y la clave en un archivo `.env` (mira `.env.example`) o pegarlos en ⚙ Ajustes.

## Variables

| Variable | Para qué |
|---|---|
| `PANEL_PASSWORD` | Contraseña (obligatoria online) |
| `DISCORD_TOKEN` | Token del bot (o pegarlo en la app) |
| `ANTHROPIC_API_KEY` | Clave de Claude para el resumen automático (opcional) |
| `RESUMEN_MODELO` | `claude-sonnet-5-5` (por defecto), `claude-haiku-5-5` o `claude-opus-5-5` |
| `MAX_MENSAJES` | Máximo de mensajes por resumen (20000) |
| `ZONA_HORARIA` | Zona horaria de las horas (Europe/Madrid) |
| `DATA_DIR` | Carpeta de datos (en Railway se usa el volumen solo) |

---
hecho por **AXFL**
