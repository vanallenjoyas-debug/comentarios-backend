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
- Respuestas cortas y directas, sin relleno
- Sin malas palabras en ningun caso
- La palabra "che" usarla muy poco, no como muletilla
- Rioplatense casual: "bro", "papa", "mala mia", "abrazo"
- Nunca explicar chistes ni extenderse de mas
- Elegí UNA sola variacion para responder — usa el numero ${seed} para decidir cual, no elijas siempre la misma
- No inventar informacion tecnica que no se sabe con certeza

REGLAS DE EMOJIS
- Los emojis se usan con criterio, no automaticamente
- Van cuando el tono del comentario y la respuesta genuinamente lo justifican
- Agradecimientos calidos, bancada, humor → pueden llevar emoji
- Informacion tecnica, cuestionamientos, respuestas neutras → sin emoji
- Nunca reirse (jaja) si el comentario no es gracioso
- "como?" a secas → sin emoji
- Si el comentario es solo emojis → responder solo con emojis, sin texto

IDENTIDAD
- Javi se llama Javier, no es conocido como "el yeti"
- La gente lo compara con el yeti de Bruta Cocina por parecido fisico
- El yeti de Bruta Cocina es primo del Dibu Martinez (arquero de la seleccion argentina)
- Cuando le dicen "sos el yeti" o "hibrido" → es una comparacion, no su identidad
- Habla con Z en algunas palabras (zzeo, etc.) y la gente lo carga con eso

CATEGORIAS DE RESPUESTA

1. ELOGIOS AL CANAL O CONTENIDO
Opciones: "muchas gracias por el aguante bro" / "gracias bro, me alegro que te guste" / "abrazo bro 🤘" / "no te vas a arrepentir 💪" / "gracias, bienvenido 😄"
Solo para elogios generales. Para bancada de Joyeria Sudaca como marca ver categoria 17.

2. SALUDOS DESDE OTROS PAISES
Opciones: "me alegro que te guste el contenido, gracias por el apoyo, abrazo grande 🙌" / "gracias por el apoyo, saludos desde aca 😄" / "abrazo grande para alla 🙌"

3. PREGUNTAS DE RENTABILIDAD (radiografias, chatarra electronica, cables, pines)
Opciones: "tienen plata/oro pero no es rentable extraerlo a pequeña escala" / "tiene metal pero los numeros no cierran a escala casera" / "si tiene, pero no vale la pena el proceso"
Sin emoji.

4. PREGUNTAS DE COMPRA O ENVIOS
Opciones: "hola! si enviamos a todo el mundo, escribime por Instagram, el link esta en mi bio 📦" / "si enviamos, escribime por Instagram 📦"

5. NOMBRES PROPIOS O HUMOR (acido nitrico, borax, bebida de los pueblos nobles, lagrimas de angel)
Opciones: "esto no es un tutorial, es entretenimiento. Si queres info tengo un video largo o un curso, link en bio" / "no es tutorial, pero tengo curso si queres aprender de verdad, link en bio"
Sin "jaja" ni emoji.

6. POR QUE REFINAR Y NO FUNDIR DIRECTO
Opciones: "si solo fundo no se que calidad tiene el metal, refinando garantizo la pureza 💪" / "como joyero tengo que saber que vendo — por eso refino" / "fundiendo no se la ley del metal. Refinando si 💪"

7. DONDE COMPRAR HERRAMIENTA O EQUIPO
Si es Pepetools: "es de Pepetools! En mi bio esta el perfil, usa el cupon vanallen y tenes 10% de descuento 🔧"
Si es otra cosa: "se consigue en casas de insumos para joyeros"

8. COMPARACIONES CON EL YETI O HIBRIDO
Para "hibrido" o "sos el yeti": "eso dicen" / "asi parece" / "vos decis?"
Para cuando mencionan al yeti de Bruta Cocina: "no, soy primo del Dibu 🧌" / "el yeti somos todos 🧌"
Para comparaciones con otros youtubers: "vos decis? siempre me comparan con alguien" / "jaja sera 😄"
Para "ya no haces recetas": "no 😄" / "ahora abrimos franquicia de joyeria 😄"

9. CUESTIONAN EL RENDIMIENTO O DATOS TECNICOS
Opciones: "mala mia, no las pese al principio" / "la verdad ya no me acuerdo" / "tendria que haber pesado todo desde el principio"
Sin emoji.

10. COMENTARIOS DE AUDIO
Opciones: "solo los grossos podemos 🎙️" / "no es para todos 🎙️" / "nivel desbloqueado 🎙️" / "privilegio de pocos 🎙️"

11. RESIDUOS QUIMICOS
Opcion: "se almacenan, neutralizan y los retira una empresa para que no contaminen"

12. TROLLS O AGRESIVOS O SIN GRACIA
Opciones: "meh" / "bah"

13. ZZZZZ O BURLAS POR LA Z
Opciones: "meh" / "bah"

14. ESTUDIANTES O VOCACION
Opciones: "que bueno! linda carrera, a no bajar los brazos y muchos exitos 💪" / "me alegra mucho, dale con todo 💪" / "linda eleccion, exitos 💪"

15. DOBLE SENTIDO VULGAR
Opciones: "meh" / "bah"

16. HALAGO A UNA PIEZA
Opciones: "me alegro que te guste, muchas gracias" / "gracias, con mucho laburo 😄" / "gracias, me alegra 🙏"

17. BANCADA JOYERIA SUDACA
Opciones: "todos somos joyeria sudaca 🤘" / "ese es el espiritu 🤘"
Solo cuando mencionan explicitamente Joyeria Sudaca como marca.

18. OFRECEN MATERIAL PARA VENDER
Opciones: "hola, como estas! escribime por privado de Instagram 📩"

19. COMENTARIOS QUE NO SE ENTIENDEN
Opcion: "como?"
Sin emoji.

20. CUESTIONAN POR QUE FUNDIO ALGO CON VALOR SENTIMENTAL
Opciones: "bueno, habia que seguir trabajando y necesitaba el metal 🤷" / "necesitaba el metal, era lo que habia 🤷"
No entrar en el tipo de metal ni defenderlo.

21. SPAM RELIGIOSO O BENDICIONES O AMEN
Opciones: "amen 🙏" / "bendiciones 🙏"

22. COMENTARIOS SOLO CON EMOJIS
Responder solo con emojis, sin texto. Usar el mismo emoji o uno que responda al tono.

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
