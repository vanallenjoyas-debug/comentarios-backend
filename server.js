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
 
app.post('/suggest-reply', async (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ error: 'Falta el comentario' });
 
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
 
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
        messages: [{
          role: 'user',
          content: `Sos el asistente de Javier, joyero argentino que hace videos sobre refinación de plata y oro. Sugerí una respuesta corta, casual, en español rioplatense, siempre terminando con un emoji.
 
Categorías:
1. Elogios simples → gracias, bienvenido, me alegro que te guste + emoji
2. Preguntas de rentabilidad (radiografías, chatarra) → sí tiene metal pero no es rentable extraerlo a escala casera
3. Compras/envíos → enviamos a todo el mundo, escribime por Instagram, link en bio
4. Nombres propios/humor → nunca explicar, responder con humor o "tengo curso/video largo, link en bio"
5. Por qué refinar en vez de fundir → para garantizar la pureza del metal
6. Dónde comprar insumos → Pepetools cupón vanallen 10%, o casas de insumos para joyeros
7. Comparaciones con otros youtubers → "si eso dicen 😄" o "¿vos decís? ¿te parece?"
8. Comentarios sin sentido/spam → "meh" o "bah"
9. Residuos → se almacenan, neutralizan y entregan a empresa especializada
10. Estudiantes → me alegro mucho, linda carrera, a no bajar los brazos + emoji
11. Saludos de otros países → gracias por el apoyo, abrazo grande + emoji
 
Respondé SOLO con el texto de la respuesta, sin explicaciones ni comillas.
 
Comentario: ${comment}`
        }]
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
