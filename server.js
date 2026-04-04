// v2 
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const session = require('express-session');
const fs = require('fs');

const app = express();
app.use(express.json());
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

// ─── Estado persistente ───────────────────────────────────────────────────────
const STATE_FILE = '/tmp/comment-state.json';

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch(e) {}
  return { answered: [], discarded: [] };
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch(e) {}
}

// ─── YouTube Auth ─────────────────────────────────────────────────────────────
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

// ─── Estado endpoints ─────────────────────────────────────────────────────────
app.get('/state', (req, res) => {
  res.json(loadState());
});

app.post('/state/answered', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Falta id' });
  const state = loadState();
  if (!state.answered.includes(id)) state.answered.push(id);
  saveState(state);
  res.json({ ok: true });
});

app.post('/state/discarded', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Falta id' });
  const state = loadState();
  if (!state.discarded.includes(id)) state.discarded.push(id);
  saveState(state);
  res.json({ ok: true });
});

// ─── YouTube Endpoints ────────────────────────────────────────────────────────
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
        answeredByMe
      };
    });
    res.json({ comments, nextPageToken: response.data.nextPageToken || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/comments/:id/reply', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    await youtube.comments.insert({
      part: 'snippet',
      requestBody: { snippet: { parentId: id, textOriginal: text } }
    });
    const state = loadState();
    if (!state.answered.includes(id)) state.answered.push(id);
    saveState(state);
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

// ─── Facebook Endpoints ───────────────────────────────────────────────────────
const FB_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;

app.get('/fb/comments', async (req, res) => {
  try {
    const { after } = req.query;
    let url = `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed?fields=id,message,created_time,comments{id,message,from,created_time}&limit=10&access_token=${FB_TOKEN}`;
    if (after) url += `&after=${after}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) {
      console.error('FB error:', JSON.stringify(data));
      return res.status(500).json({ error: data.error?.message || 'Error de Facebook' });
    }
    const comments = [];
    for (const post of (data.data || [])) {
      if (!post.comments?.data?.length) continue;
      for (const c of post.comments.data) {
        comments.push({
          id: c.id,
          postId: post.id,
          postMessage: post.message || '',
          text: c.message,
          author: c.from?.name || 'Usuario',
          authorPhoto: `https://graph.facebook.com/${c.from?.id}/picture?type=square`,
          publishedAt: c.created_time,
          network: 'fb'
        });
      }
    }
    res.json({ comments, nextCursor: data.paging?.cursors?.after || null });
  } catch (e) {
    console.error('fb/comments error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/fb/comments/:id/reply', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, access_token: FB_TOKEN })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('FB reply error:', JSON.stringify(data));
      return res.status(500).json({ error: data.error?.message || 'Error al responder' });
    }
    const state = loadState();
    if (!state.answered.includes(id)) state.answered.push(id);
    saveState(state);
    res.json({ ok: true });
  } catch (e) {
    console.error('fb reply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── IA Sugerencias ───────────────────────────────────────────────────────────
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

app.post('/suggest-reply', async (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ error: 'Falta el comentario' });

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const seed = randomInt(1, 999);

  const prompt = `Sos el asistente de respuestas de comentarios de Javi (Javier Romero), joyero argentino creador del canal Joyeria Sudaca. Tu tarea es sugerir respuestas a comentarios de sus redes sociales imitando su voz y estilo exactos.

ESTILO GENERAL
- Respuestas cortas y directas, sin relleno
- Sin malas palabras en ningun caso
- La palabra "che" usarla muy poco, no como muletilla
- Rioplatense casual: "bro", "papa", "mala mia", "abrazo"
- Nunca explicar chistes ni extenderse de mas
- Elegir UNA sola opcion — usar el numero ${seed} para decidir cual, no elegir siempre la misma
- No inventar informacion tecnica que no se sabe con certeza
- La marca se escribe siempre "Sudaca" con C, nunca con K

REGLAS DE EMOJIS
- Los emojis se usan con criterio, no automaticamente
- Agradecimientos calidos, bancada, humor compartido pueden llevar emoji
- Informacion tecnica, cuestionamientos, respuestas neutras sin emoji
- Nunca reirse si el comentario no es gracioso
- Si el comentario es solo emojis responder solo con emojis, sin texto

IDENTIDAD
- Javi se llama Javier, no es conocido como "el yeti"
- La gente lo compara con el yeti de Bruta Cocina por parecido fisico
- El yeti de Bruta Cocina es primo del Dibu Martinez
- Habla con Z en algunas palabras y la gente lo carga con eso

CATEGORIAS
1. Elogios: "muchas gracias por el aguante bro" / "gracias bro, me alegro que te guste" / "abrazo bro 🤘" / "no te vas a arrepentir 💪"
2. Saludos otros paises: "me alegro que te guste, gracias por el apoyo, abrazo grande 🙌" / "abrazo grande para alla 🙌"
3. Rentabilidad chatarra: "tienen metal pero no es rentable extraerlo a pequeña escala" / "tiene metal pero la cantidad no justifica el proceso"
4. Compras/envios: "hola! si enviamos a todo el mundo, escribime por Instagram 📦"
5. Nombres propios/humor: "el proceso esta explicado en un long de este canal" / "si queres info tengo un curso, link en bio"
6. Por que refinar: "si solo fundo no se que calidad tiene el metal, refinando garantizo la pureza" / "como joyero tengo que saber que vendo"
7. Pepetools: "es de Pepetools! usa el cupon vanallen, tenes 10% off 🔧" / Otro equipo: "se consigue en casas de insumos para joyeros"
8. Yeti/hibrido: "eso dicen" / "asi parece" / "vos decis?" / "no, soy primo del Dibu 🧌"
9. Bruta Cocina: "podriamos ser una franquicia 😄" / "podriamos ser una sucursal 😄"
10. Datos tecnicos: "mala mia, no lo medi desde el arranque" / "la verdad ya no me acuerdo 😅"
11. Audio: "solo los grossos podemos 🎙️" / "no es para todos 🎙️" / "privilegio de pocos 🎙️"
12. Residuos: "se almacenan, neutralizan y los retira una empresa para que no contaminen"
13. Trolls: "meh" / "bah"
14. Estudiantes: "que bueno! linda carrera, a no bajar los brazos 💪"
15. Halago pieza: "me alegro que te guste, muchas gracias" / "gracias, fue hecha con mucho cuidado"
16. Bancada Sudaca: "todos somos joyeria sudaca 🤘"
17. Ofrecen material: "hola, como estas! escribime por privado de Instagram 📩"
18. No se entiende: "como?"
19. Fundio algo sentimental: "habia que seguir trabajando y necesitaba el metal 🤷"
20. Bendiciones/amen: "amen 🙏" / "bendiciones 🙏"
21. Solo emojis: responder solo con emojis
22. Tono simpatico sin contexto: "y si, el oficio es asi" / "puede pasar" / "parte del trabajo"
23. Corrigen ortografia Sudaca: "yo lo escribo con c 😄"
24. Si algo se puede fundir: "si, se puede fundir y hacer un lingote"
25. Breaking Bad/Heisenberg: "jaja algo escuche 😂" / "el nombre me suena 😂"
26. Acusan de plagio: "yo hablo asi, no me copio de nadie" / "siempre hable asi"
27. Cuestionan diseño: "el joyero soy yo, la puse asi a proposito 😄" / "asi la pidio el cliente 🙌"

INSTRUCCION: Da UNA SOLA respuesta lista para publicar, sin comillas ni explicaciones.

Comentario: ${comment}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Anthropic error:', JSON.stringify(data));
      return res.status(500).json({ error: data.error?.message || 'Error de API' });
    }
    res.json({ suggestion: data.content?.[0]?.text || '' });
  } catch (e) {
    console.error('suggest-reply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));

