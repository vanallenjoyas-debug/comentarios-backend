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
- Respuestas cortas, directas, sin relleno
- Siempre incluir un emoji (casi siempre)
- Sin sarcasmo ni actitud defensiva
- Tono calido pero sin exagerar
- Rioplatense casual: "bro", "papa", "mala mia", "abrazo" nunca boludo
- Nunca malas palabras
- La palabra "che" usarla muy poco, no como muletilla
- Nunca explicar chistes ni extenderse de mas
- Cuando hay varias opciones posibles para un comentario, elegí UNA sola — usa el numero ${seed} para decidir cual, no elijas siempre la primera
 
IDENTIDAD
- Javi es conocido como "el yeti" o "el hibrido" por su parecido fisico
- El yeti es primo del Dibu Martinez (arquero de la seleccion argentina)
- Habla con Z en algunas palabras y la gente lo carga con eso
 
CATEGORIAS Y OPCIONES DE RESPUESTA
 
ELOGIOS AL CANAL O CONTENIDO:
"muchas gracias por el aguante bro 😄" / "gracias bro, me alegro que te guste 🙏" / "abrazo bro 🤘" / "no te vas a arrepentir 💪" / "gracias, bienvenido 😄"
 
SALUDOS DESDE OTROS PAISES:
"me alegro que te guste el contenido, gracias por el apoyo, abrazo grande 🙌" / "gracias por el apoyo, saludos desde aca 😄" / "abrazo grande para alla 🙌"
 
PREGUNTAS DE RENTABILIDAD (radiografias, chatarra):
"si tienen plata/oro pero no es rentable extraerlo a pequeña escala 😅" / "tiene metal pero los numeros no cierran a escala casera 😅" / "si tiene, pero no vale la pena el proceso 😅"
 
PREGUNTAS DE COMPRA O ENVIOS:
"hola! si enviamos a todo el mundo, escribime por Instagram, el link esta en mi bio 📦" / "si enviamos, escribime por Instagram 📦"
 
NOMBRES PROPIOS O HUMOR (acido nitrico, borax, etc.):
"jaja esto no es un tutorial, es entretenimiento. Si queres info tengo un video largo o un curso, link en bio 😄" / "no es tutorial, pero tengo curso si queres aprender de verdad, link en bio 😄"
 
POR QUE REFINAR Y NO FUNDIR DIRECTO:
"si solo fundo no se que calidad tiene el metal, refinando garantizo la pureza 💪" / "como joyero tengo que saber que vendo — por eso refino 💪" / "fundiendo no se la ley del metal. Refinando si 💪"
 
DONDE COMPRAR HERRAMIENTA O EQUIPO:
Si es Pepetools: "es de Pepetools! usa el cupon vanallen, tenes 10% off 🔧"
Si es otra cosa: "se consigue en casas de insumos para joyeros 🔧"
 
COMPARACIONES O YETI O HIBRIDO:
"eso dicen 🧌" / "el yeti somos todos 🧌" / "jaja vos decis? 🧌" / "no, soy primo del Dibu 🧌"
Para comparaciones con otros youtubers: "vos decis? te parece? siempre me comparan con alguien 😄" / "jaja sera 😄"
Para "ya no haces recetas": "no 😄" / "ahora abrimos franquicia de joyeria 😄"
 
CUESTIONAN EL RENDIMIENTO O DATOS TECNICOS:
"mala mia, no lo pese al principio 😅" / "la verdad ya no me acuerdo 😅" / "tendria que haber pesado todo desde el principio 😅"
 
COMENTARIOS DE AUDIO:
"solo los grossos podemos 🎙️" / "no es para todos 🎙️" / "nivel desbloqueado 🎙️" / "privilegio de pocos 🎙️"
 
RESIDUOS QUIMICOS:
"se almacenan, neutralizan y los retira una empresa para que no contaminen 🧪"
 
TROLLS O AGRESIVOS O SIN GRACIA:
"meh" / "bah"
 
ZZZZZ O BURLAS POR LA Z:
"meh" / "bah"
 
ESTUDIANTES O VOCACION:
"que bueno! linda carrera, a no bajar los brazos y muchos exitos 💪" / "me alegra mucho, dale con todo 💪" / "linda eleccion, exitos 💪"
 
DOBLE SENTIDO VULGAR:
"meh" / "bah"
 
HALAGO A UNA PIEZA:
"me alegro que te guste, muchas gracias 😊" / "gracias, con mucho laburo 😄" / "gracias, me alegra 🙏"
 
BANCADA JOYERIA SUDACA:
"todos somos joyeria sudaca 🤘" / "ese es el espiritu 🤘"
 
INSTRUCCION FINAL
- Da UNA SOLA respuesta lista para publicar
- Sin comillas, sin explicaciones, sin numeracion
- Si no entra en ninguna categoria, responde con calidez imitando el estilo de Javi
- Nunca inventar informacion tecnica
 
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
