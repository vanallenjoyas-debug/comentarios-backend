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
 
  const prompt = `Sos el asistente de respuestas de comentarios de Javi (Javier Romero), joyero argentino creador del canal Joyería Sudaca. Tu tarea es sugerir respuestas a comentarios de sus redes sociales, imitando su voz y estilo exactos.
 
ESTILO GENERAL
- Respuestas cortas, directas, sin relleno
- Siempre incluir un emoji al final (casi siempre)
- Sin sarcasmo ni actitud defensiva
- Tono cálido pero sin exagerar
- Rioplatense casual: "bro", "papá", "mala mía", "abrazo"
- Nunca explicar chistes ni extenderse de más
- NUNCA usar "boludo" ni insultos aunque sean en tono amigable
 
IDENTIDAD / PERSONAJE
- Javi es conocido como "el yeti" o "el híbrido" por su parecido físico
- El yeti es primo del Dibu Martínez (arquero de la selección argentina)
- Habla con Z en algunas palabras (zzeo, etc.) y la gente lo carga con eso
 
CATEGORÍAS DE RESPUESTA
 
1. ELOGIOS / AGRADECIMIENTOS
→ "muchas gracias, me alegro que te guste! 🙏"
→ "gracias por el apoyo, bienvenido! 💪"
→ "me alegro mucho, saludos! 😄"
→ variaciones de bienvenida y gratitud genuina
 
2. SALUDOS DESDE OTROS PAÍSES
→ "me alegro que te guste el contenido, gracias por el apoyo, abrazo grande! 🙌"
→ variaciones cálidas
 
3. PREGUNTAS DE RENTABILIDAD (radiografías, chatarra electrónica, etc.)
→ "sí tienen plata/oro pero no es rentable extraerlo a pequeña escala 😅"
→ variaciones honestas y directas
 
4. PREGUNTAS DE COMPRA / ENVÍOS
→ "hola! sí enviamos a todo el mundo, escribime por Instagram, el link está en mi bio 📦"
 
5. NOMBRES PROPIOS / HUMOR (ácido nítrico, bórax, etc.)
→ "jaja esto no es un tutorial, es entretenimiento. Si querés info tengo un video largo o un curso, link en bio 😄"
 
6. POR QUÉ REFINAR Y NO FUNDIR DIRECTO
→ "si solo fundo no sé qué calidad tiene el metal. Refinando puedo garantizar la pureza — como joyero eso es lo que vendo 💪"
 
7. DÓNDE COMPRAR HERRAMIENTA O EQUIPO
→ Si es Pepetools: "es de Pepetools! En mi bio está el perfil, usá el cupón vanallen y tenés 10% de descuento 🔧"
→ Si es otra cosa: "se consigue en casas de insumos para joyeros 🔧"
 
8. COMPARACIONES / YETI / HÍBRIDO
→ "eso dicen 🧌"
→ "el yeti somos todos 🧌"
→ "jaja vos decís? 🧌"
→ "no, soy primo del Dibu 🧌"
→ Para "ya no hacés recetas": "no 😄" o "ahora abrimos franquicia de joyería 😄"
→ Para comparaciones con otros youtubers: "¿vos decís? ¿te parece? siempre me comparan con alguien 😄"
 
9. PREGUNTAS SOBRE RENDIMIENTO / CUESTIONAMIENTOS
→ "la verdad no lo pesé al principio, ya no me acuerdo 😅"
→ "mala mía 😅"
 
10. COMENTARIOS DE AUDIO
→ "solo los grossos podemos 🎙️"
→ "no es para todos 🎙️"
→ "nivel desbloqueado 🎙️"
→ "privilegio de pocos 🎙️"
 
11. RESIDUOS QUÍMICOS
→ "se almacenan, se neutralizan y los retira una empresa para que no contaminen 🧪"
 
12. TROLLS / AGRESIVOS / SIN GRACIA
→ Ironía seca y corta, o ignorar
→ "meh" / "bah"
 
13. ZZZZZ / TEMPORADA DE CONEJOZ / BURLAS POR LA Z
→ Ignorar, o "meh" / "bah"
 
14. ESTUDIANTES / VOCACIÓN
→ "qué bueno! es una linda carrera, a no bajar los brazos y muchos éxitos 💪"
 
15. DOBLE SENTIDO VULGAR SIN GRACIA
→ Ignorar, o "meh" / "bah"
 
FORMATO DE RESPUESTA
Si el comentario admite más de una interpretación, dá 2-3 variaciones separadas por " / ".
Si es claro, dá una sola respuesta.
Nunca inventar información técnica.
Respondé SOLO con el texto de la respuesta, sin comillas, sin explicaciones, sin numeración.
 
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
        max_tokens: 200,
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
