const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const session = require('express-session');
 
const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://storied-squirrel-fb5eea.netlify.app', 'https://moonlit-crumble-d1585d.netlify.app', 'http://localhost:3000'],
  credentials: true
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sudaca-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
 
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
 
function requireAuth(req, res, next) {
  let tokens = req.session.tokens;
  if (!tokens && req.headers['x-yt-token']) {
    try { tokens = JSON.parse(Buffer.from(req.headers['x-yt-token'], 'base64').toString()); } catch(e) {}
  }
  if (!tokens) return res.status(401).json({ error: 'No autenticado' });
  oauth2Client.setCredentials(tokens);
  req.ytTokens = tokens;
  next();
}
 
app.get('/comments', requireAuth, async (req, res) => {
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const { pageToken } = req.query;
    const response = await youtube.commentThreads.list({
      part: 'snippet',
      allThreadsRelatedToChannelId: process.env.YOUTUBE_CHANNEL_ID,
      maxResults: 50,
      order: 'time',
      pageToken: pageToken || undefined
    });
    const comments = response.data.items.map(item => ({
      id: item.id,
      videoId: item.snippet.videoId,
      text: item.snippet.topLevelComment.snippet.textDisplay,
      author: item.snippet.topLevelComment.snippet.authorDisplayName,
      authorPhoto: item.snippet.topLevelComment.snippet.authorProfileImageUrl,
      publishedAt: item.snippet.topLevelComment.snippet.publishedAt,
      likeCount: item.snippet.topLevelComment.snippet.likeCount,
      replyCount: item.snippet.totalReplyCount
    }));
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
    res.json({ title: video?.snippet?.title || 'Sin título' });
  } catch (e) {
    res.json({ title: 'Video' });
  }
});
 
// Número random para forzar variación en las respuestas
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
 
app.post('/suggest-reply', async (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ error: 'Falta el comentario' });
 
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const seed = randomInt(1, 100);
 
  const prompt = `Sos Javi (Javier Romero), joyero argentino del canal Joyería Sudaca. Respondés comentarios de YouTube con tu voz real.
 
ESTILO: corto, directo, cálido sin exagerar, rioplatense. Emojis preferidos: 😄 🙏 💪 🙌 😅 🧌 🔧 🧪 🎙️ ❤️ 👋. NUNCA uses 🙏🏼🤝💯🔥⭐ ni emojis genéricos de internet. NUNCA uses "boludo" ni insultos.
 
IDENTIDAD: te llaman "el yeti" o "el híbrido". Sos primo del Dibu Martínez. A veces usás Z (zzeo). Eso es un chiste interno con tu comunidad.
 
EJEMPLOS REALES de cómo respondés:
 
Comentario: "qué bueno el video!" → "gracias, me alegro que te guste 😄" o "gracias por el apoyo 🙏" o "bienvenido al canal 👋"
Comentario: "saludos desde México" → "gracias por el apoyo, abrazo grande desde acá 🙌" o "me alegra que llegue hasta allá, saludos! 😄"
Comentario: "sos el yeti" → "eso dicen 🧌" o "el yeti somos todos 🧌" o "no, soy primo del Dibu 🧌"
Comentario: "sos igual a Diego Recicla" → "¿vos decís? siempre me comparan con alguien 😄" o "jaja será 😄"
Comentario: "por qué refinás en vez de fundir?" → "si solo fundo no sé la calidad del metal. Refinando garantizo la pureza, eso es lo que vendo como joyero 💪"
Comentario: "dónde comprás las herramientas?" → "en casas de insumos para joyeros 🔧"
Comentario: "es de Pepetools?" → "sí! usá el cupón vanallen, tenés 10% off 🔧"
Comentario: "qué hacés con los residuos?" → "se almacenan, neutralizan y los retira una empresa especializada 🧪"
Comentario: "el audio es horrible" → "solo los grossos podemos 🎙️" o "no es para todos 🎙️" o "privilegio de pocos 🎙️"
Comentario: "cuánto oro sacaste?" → "la verdad no lo pesé bien al principio 😅" o "mala mía, no lo registré 😅"
Comentario: "estudié joyería gracias a vos" → "qué bueno! linda carrera, a no bajar los brazos 💪"
Comentario: "las radiografías tienen plata?" → "sí tienen pero no es rentable extraerla a pequeña escala 😅"
Comentario: "enviás a Chile?" → "sí! enviamos a todo el mundo, escribime por Instagram, link en bio 📦"
Comentario: "jaja el ácido nítrico" → "esto no es tutorial, es entretenimiento. Tengo un curso si querés info real, link en bio 😄"
Comentario (insulto/troll/sin sentido): → "meh" o "bah"
 
Número de sesión: ${seed}. Usalo para elegir una respuesta diferente cada vez entre las opciones posibles para ese tipo de comentario.
 
Dá UNA SOLA respuesta lista para publicar. Sin comillas, sin explicaciones.
 
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
 
    const suggestion = data.content?.[0]?.text || '';
    res.json({ suggestion });
 
  } catch (e) {
    console.error('suggest-reply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
