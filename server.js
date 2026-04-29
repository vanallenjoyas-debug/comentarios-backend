// server-yt v2 - YouTube + stubs FB
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const session = require('express-session');
const { Pool } = require('pg');

const app = express();

app.use((req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    try {
      req.body = data ? JSON.parse(data.replace(/[\x00-\x1F\x7F]/g, ' ')) : {};
    } catch(e) { req.body = {}; }
    next();
  });
});

app.use(cors({
  origin: [
    'https://storied-squirrel-fb5eea.netlify.app',
    'https://moonlit-crumble-d1585d.netlify.app',
    'https://vanallenjoyas-debug.github.io',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sudaca-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

console.log("DB URL:", process.env.PG_URL || "NO URL FOUND");
const pool = new Pool({ connectionString: process.env.PG_URL });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_state (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      comment_text TEXT,
      video_title TEXT,
      reply_text TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB lista');
}

async function getState() {
  const res = await pool.query(`SELECT id, status FROM comment_state`);
  const answered = res.rows.filter(r => r.status === 'answered').map(r => r.id);
  const discarded = res.rows.filter(r => r.status === 'discarded').map(r => r.id);
  return { answered, discarded };
}

async function markAnswered(id, commentText, replyText, videoTitle) {
  await pool.query(`
    INSERT INTO comment_state (id, status, comment_text, reply_text, video_title)
    VALUES ($1, 'answered', $2, $3, $4)
    ON CONFLICT (id) DO UPDATE SET status='answered', reply_text=$3, video_title=$4
  `, [id, commentText || '', replyText || '', videoTitle || '']);
}

async function markDiscarded(id) {
  await pool.query(`
    INSERT INTO comment_state (id, status)
    VALUES ($1, 'discarded')
    ON CONFLICT (id) DO UPDATE SET status='discarded'
  `, [id]);
}

async function getExamples(limit = 20) {
  const res = await pool.query(`
    SELECT comment_text, reply_text, video_title FROM comment_state
    WHERE status = 'answered' AND comment_text != '' AND reply_text != ''
    ORDER BY created_at DESC LIMIT $1
  `, [limit]);
  return res.rows;
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

app.get('/auth/youtube', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.force-ssl'],
    prompt: 'consent'
  });
  res.json({ url });
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    const tokenEncoded = Buffer.from(JSON.stringify(tokens)).toString('base64');
    res.redirect(process.env.FRONTEND_URL + '?auth=success&token=' + tokenEncoded);
  } catch (e) {
    res.redirect(process.env.FRONTEND_URL + '?auth=error');
  }
});

app.get('/auth/status', (req, res) => {
  let tokens = req.session.tokens;
  if (!tokens && req.headers['x-yt-token']) {
    try { tokens = JSON.parse(Buffer.from(req.headers['x-yt-token'], 'base64').toString()); } catch(e) {}
  }
  res.json({ authenticated: !!tokens });
});

app.get('/auth/channel', async (req, res) => {
  let tokens = req.session.tokens;
  if (!tokens && req.headers['x-yt-token']) {
    try { tokens = JSON.parse(Buffer.from(req.headers['x-yt-token'], 'base64').toString()); } catch(e) {}
  }
  if (!tokens) return res.json({ name: null });
  try {
    oauth2Client.setCredentials(tokens);
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const response = await youtube.channels.list({ part: 'snippet', mine: true });
    const channel = response.data.items?.[0];
    res.json({ name: channel?.snippet?.title || null, handle: channel?.snippet?.customUrl || null });
  } catch (e) {
    res.json({ name: null });
  }
});

function requireAuth(req, res, next) {
  let tokens = req.session.tokens;
  if (!tokens && req.headers['x-yt-token']) {
    try { tokens = JSON.parse(Buffer.from(req.headers['x-yt-token'], 'base64').toString()); } catch(e) {}
  }
  if (!tokens) return res.status(401).json({ error: 'No autenticado' });
  oauth2Client.setCredentials(tokens);
  next();
}

app.get('/state', async (req, res) => {
  try { res.json(await getState()); }
  catch(e) { res.json({ answered: [], discarded: [] }); }
});

app.post('/state/answered', async (req, res) => {
  const { id, commentText, replyText } = req.body;
  if (!id) return res.status(400).json({ error: 'Falta id' });
  try { await markAnswered(id, commentText, replyText); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/state/discarded', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Falta id' });
  try { await markDiscarded(id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

const MY_CHANNEL_ID = 'UCsGYMvcMeUCxXIx--A7SU6w';

app.get('/comments', requireAuth, async (req, res) => {
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const { pageToken } = req.query;
    const response = await youtube.commentThreads.list({
      part: 'snippet,replies',
      allThreadsRelatedToChannelId: process.env.YOUTUBE_CHANNEL_ID,
      maxResults: 50,
      order: 'time',
      pageToken: pageToken || undefined
    });
    const state = await getState();
    const comments = response.data.items.map(item => {
      const replies = item.replies?.comments || [];
      const answeredByMe = replies.some(r => r.snippet.authorChannelId?.value === MY_CHANNEL_ID);
      return {
        id: item.id,
        videoId: item.snippet.videoId,
        text: item.snippet.topLevelComment.snippet.textDisplay,
        author: item.snippet.topLevelComment.snippet.authorDisplayName,
        authorPhoto: item.snippet.topLevelComment.snippet.authorProfileImageUrl,
        publishedAt: item.snippet.topLevelComment.snippet.publishedAt,
        likeCount: item.snippet.topLevelComment.snippet.likeCount,
        replyCount: item.snippet.totalReplyCount,
        answeredByMe,
        answered: answeredByMe || state.answered.includes(item.id)
      };
    }).filter(c => !c.answeredByMe && !state.answered.includes(c.id) && !state.discarded.includes(c.id));
    res.json({ comments, nextPageToken: response.data.nextPageToken || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/comments/:id/reply', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { text, commentText } = req.body;
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    await youtube.comments.insert({
      part: 'snippet',
      requestBody: { snippet: { parentId: id, textOriginal: text } }
    });
    await markAnswered(id, commentText || '', text, req.body.videoTitle || '');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/video/:id', requireAuth, async (req, res) => {
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const response = await youtube.videos.list({ part: 'snippet', id: req.params.id });
    const video = response.data.items[0];
    res.json({ title: video?.snippet?.title || 'Sin titulo' });
  } catch (e) {
    res.json({ title: 'Video' });
  }
});

app.get('/channel/videos', requireAuth, async (req, res) => {
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const { pageToken } = req.query;
    const response = await youtube.search.list({
      part: 'snippet',
      channelId: process.env.YOUTUBE_CHANNEL_ID,
      type: 'video',
      order: 'date',
      maxResults: 50,
      pageToken: pageToken || undefined
    });
    const videos = response.data.items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.default?.url || ''
    }));
    res.json({ videos, nextPageToken: response.data.nextPageToken || null });
  } catch (e) {
    console.error('channel/videos error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/video/:id/comments', requireAuth, async (req, res) => {
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const { pageToken } = req.query;
    const response = await youtube.commentThreads.list({
      part: 'snippet,replies',
      videoId: req.params.id,
      maxResults: 100,
      order: 'time',
      pageToken: pageToken || undefined
    });
    const state = await getState();
    const comments = response.data.items.map(item => {
      const replies = item.replies?.comments || [];
      const answeredByMe = replies.some(r => r.snippet.authorChannelId?.value === MY_CHANNEL_ID);
      return {
        id: item.id,
        videoId: req.params.id,
        text: item.snippet.topLevelComment.snippet.textDisplay,
        author: item.snippet.topLevelComment.snippet.authorDisplayName,
        authorPhoto: item.snippet.topLevelComment.snippet.authorProfileImageUrl,
        publishedAt: item.snippet.topLevelComment.snippet.publishedAt,
        likeCount: item.snippet.topLevelComment.snippet.likeCount,
        replyCount: item.snippet.totalReplyCount,
        answered: answeredByMe || state.answered.includes(item.id),
network: 'yt'
      };
    });
    res.json({ comments, nextPageToken: response.data.nextPageToken || null });
  } catch (e) {
    console.error('video comments error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/suggest-reply', async (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ error: 'Falta el comentario' });
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const variations = [
    'Se muy directo y conciso, sin adornos',
    'Se calido y cercano, como hablando con un amigo',
    'Se humoristico y liviano si el comentario lo permite',
    'Se tecnico y preciso si el comentario es tecnico'
  ];
  const variationStyle = variations[Math.floor(Math.random() * variations.length)];
  let ejemplos = '';
  try {
    const examples = await getExamples(15);
    if (examples.length > 0) {
      ejemplos = '\n\nEJEMPLOS REALES DE RESPUESTAS DE JAVI (segui este estilo):\n';
      examples.forEach((ex, i) => {
        ejemplos += `\nEjemplo ${i+1}:${ex.video_title ? "\n(Video: "+ex.video_title+")" : ""}\nComentario: "${ex.comment_text}"\nRespuesta: "${ex.reply_text}"\n`;
      });
      ejemplos += '\n';
    }
  } catch(e) {}
  const prompt = `Sos Javi (Javier Romero), joyero argentino del canal Joyeria Sudaca. Responde este comentario exactamente como lo haria Javi.${ejemplos}

EJEMPLOS DE COMO RESPONDE JAVI:
- Elogio -> "Muchas gracias bro, me alegro que te guste 🙌"
- "Es rentable?" -> "Si tiene plata pero no es muy rentable de extraer"
- "Me vendes uno?" -> "Hola! Si enviamos a todo el mundo, escribime por privado de Instagram, link en mi perfil"
- "Por que no fundis directo?" -> "Si solo fundimos no podemos garantizar la pureza del metal"
- "Donde lo compro?" (Pepetools) -> "Esta en mi bio, cupon vanallen 10% de descuento"
- Saludo desde otro pais -> "Me alegro que te guste el contenido, abrazo grande bro"
- "Hibrido!!!" -> "Si eso dicen 😄"
- Comentario gracioso -> reirse y nada mas, nunca explicar el chiste

REGLAS:
- Respuesta CORTA, maximo 2 oraciones
- Un solo emoji cuando corresponde, nunca en respuestas tecnicas
- Nunca exagerar el acento: nada de "papa", "che" a cada rato, ni caricatura argentina
- Nunca explicar chistes ni justificarse
- Si preguntan por proceso quimico o tecnico complejo -> "Para mas info escribime por privado 👋"
- Si preguntan por cursos -> "Mandame mensaje privado y te paso toda la info 👋"
- Si preguntan por compra o envio -> mandar por privado a Instagram
- IMPORTANTE: nunca escribir "mandate", siempre "mandame"
- No inventar datos tecnicos
- La marca es "Sudaca" con C, nunca con K
- Si el comentario es solo emojis -> responder solo con emojis
- Estilo de esta respuesta: ${variationStyle}

INSTRUCCION: UNA SOLA respuesta lista para publicar, sin comillas ni explicaciones.
Comentario: ${comment}`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 150, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'Error de API' });
    res.json({ suggestion: data.content?.[0]?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FB stubs - devuelven vacio, no rompen el frontend
app.get('/fb/comments', async (req, res) => {
  res.json({ comments: [], nextCursor: null });
});

app.post('/fb/comments/:id/reply', async (req, res) => {
  res.json({ ok: true });
});

app.get('/version', (req, res) => res.json({ version: 'server-yt-v2' }));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`server-yt-v2 corriendo en puerto ${PORT}`));
}).catch(e => {
  console.error('Error iniciando DB:', e.message);
  app.listen(PORT, () => console.log(`server-yt-v2 sin DB en puerto ${PORT}`));
});
