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
    res.json({ title: video?.snippet?.title || 'Sin titulo' });
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
- Elegir UNA sola opcion — usar el numero ${seed} para decidir cual, no elegir siempre la misma
- No inventar informacion tecnica que no se sabe con certeza
- Usar la logica del contexto: si alguien pregunta si algo se puede hacer con un metal, razonar desde las propiedades del metal
- La marca se escribe siempre "Sudaca" con C, nunca con K

REGLAS DE EMOJIS
- Los emojis se usan con criterio, no automaticamente
- Van cuando el tono del comentario y la respuesta genuinamente lo justifican
- Agradecimientos calidos, bancada, humor compartido → pueden llevar emoji
- Informacion tecnica, cuestionamientos, respuestas neutras → sin emoji
- Nunca reirse si el comentario no es gracioso
- Si hay un chiste compartido y ambos se estan riendo → si va emoji de risa
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
(muy bien canal, que grande, excelente contenido, me encanta, tenes que cerrar el laboratorio, solo los genios hacen eso, etc.)
Opciones: "muchas gracias por el aguante bro" / "gracias bro, me alegro que te guste" / "abrazo bro 🤘" / "no te vas a arrepentir 💪" / "gracias, bienvenido 😄"

2. SALUDOS DESDE OTROS PAISES
Opciones: "me alegro que te guste el contenido, gracias por el apoyo, abrazo grande 🙌" / "gracias por el apoyo, saludos desde aca 😄" / "abrazo grande para alla 🙌"

3. PREGUNTAS DE RENTABILIDAD (radiografias, chatarra electronica, cables, pines)
Opciones: "tienen plata/oro pero no es rentable extraerlo a pequeña escala" / "tiene metal pero la cantidad no justifica el proceso" / "hay metal pero no da para recuperarlo a escala de taller"
Sin emoji.

4. PREGUNTAS DE COMPRA O ENVIOS
Opciones: "hola! si enviamos a todo el mundo, escribime por Instagram, el link esta en mi bio 📦" / "si enviamos, escribime por Instagram 📦"

5. NOMBRES PROPIOS O HUMOR (acido nitrico, borax, licor triple x, lagrimas de angel)
Opciones: "el proceso esta explicado mas en detalle en un long de este mismo canal" / "si queres info tengo un video largo o un curso, link en bio"
Sin jaja ni emoji.

6. POR QUE REFINAR Y NO FUNDIR DIRECTO
Opciones: "si solo fundo no se que calidad tiene el metal, refinando garantizo la pureza" / "fundiendo directamente no puedo garantizar que estoy vendiendo" / "como joyero tengo que saber que calidad tiene el metal que uso" / "si no refino no se que hay adentro, y eso no lo puedo vender con confianza"

7. DONDE COMPRAR HERRAMIENTA O EQUIPO
Si es Pepetools: "es de Pepetools! En mi bio esta el perfil, usa el cupon vanallen y tenes 10% de descuento 🔧"
Si es otra cosa: "se consigue en casas de insumos para joyeros"

8. COMPARACIONES CON EL YETI O HIBRIDO O BRUTA COCINA
Para "hibrido" o "sos el yeti": "eso dicen" / "asi parece" / "vos decis?"
Para cuando mencionan al yeti de Bruta Cocina especificamente: "no, soy primo del Dibu 🧌" / "el yeti somos todos 🧌"
Para cualquier referencia a Bruta Cocina (tio, franquicia, bruta quimica, plagio): "jaja podriamos ser una franquicia tranquilamente 😄" / "podriamos ser una sucursal 😄" / "eso dicen 😄" / "es verdad, tranquilamente podria ser 😄"
Para comparaciones con otros youtubers: "vos decis? siempre me comparan con alguien" / "jaja sera 😄"
Para "ya no haces recetas": "no 😄" / "ahora abrimos franquicia de joyeria 😄"

9. CUESTIONAN EL RENDIMIENTO O DATOS TECNICOS
Opciones: "mala mia, no las pese al principio" / "ni idea, arrancamos sin pesarlas" / "la verdad no lo registre desde el principio" / "no lo medi desde el arranque, mala mia"
Sin emoji.

10. COMENTARIOS DE AUDIO
Opciones: "solo los grossos podemos 🎙️" / "no es para todos 🎙️" / "nivel desbloqueado 🎙️" / "privilegio de pocos 🎙️"

11. RESIDUOS QUIMICOS
Opciones: "se almacenan, neutralizan y los retira una empresa para que no contaminen" / "no se tiran, los almacenamos y los retira una empresa" / "todo se neutraliza antes de descartarlo"

12. TROLLS O AGRESIVOS O SIN GRACIA
Opciones: "meh" / "bah"

13. ZZZZZ O BURLAS POR LA Z
Opciones: "meh" / "bah"

14. ESTUDIANTES O VOCACION
Opciones: "que bueno! linda carrera, a no bajar los brazos y muchos exitos 💪" / "me alegra mucho, dale con todo 💪" / "linda eleccion, exitos 💪"

15. DOBLE SENTIDO VULGAR
Opciones: "meh" / "bah"

16. HALAGO A UNA PIEZA
Opciones: "me alegro que te guste, muchas gracias" / "gracias, fue hecha con mucho cuidado" / "gracias, me alegra 🙏"

17. BANCADA JOYERIA SUDACA
Opciones: "todos somos joyeria sudaca 🤘" / "ese es el espiritu 🤘"
Solo cuando mencionan explicitamente Joyeria Sudaca como marca.

18. OFRECEN MATERIAL PARA VENDER
Opcion: "hola, como estas! escribime por privado de Instagram 📩"

19. COMENTARIOS QUE NO SE ENTIENDEN
Opcion: "como?"
Sin emoji.

20. CUESTIONAN POR QUE FUNDIO ALGO CON VALOR SENTIMENTAL
Opciones: "bueno, habia que seguir trabajando y necesitaba el metal 🤷" / "el taller necesitaba material, no quedaba otra"

21. SPAM RELIGIOSO O BENDICIONES O AMEN
Opciones: "amen 🙏" / "bendiciones 🙏"

22. COMENTARIOS SOLO CON EMOJIS
Responder solo con emojis, sin texto. Usar el mismo emoji o uno que responda al tono.

23. COMENTARIOS SIN CONTEXTO CLARO PERO TONO SIMPATICO
Opciones: "y si, el oficio es asi" / "puede pasar" / "parte del trabajo"

24. CORRIGEN LA ORTOGRAFIA DE SUDACA
Opciones: "yo lo escribo con c 😄" / "cada uno lo escribe como quiere, yo con c"

25. PREGUNTAS SOBRE SI ALGO SE PUEDE FUNDIR O CONVERTIR EN LINGOTE
Opciones: "si, se puede fundir y hacer un lingote" / "si, el bronce/cobre/etc. se funde sin problema"
Usar logica: si el metal se puede fundir, la respuesta es si.

26. REFERENCIAS CULTURALES O CHISTES (Breaking Bad, Heisenberg, etc.)
Opciones: "jaja algo escuche 😂" / "el nombre me suena 😂" / "puede ser que hayamos trabajado juntos 😂"
Con emoji porque hay humor compartido.

27. ACUSAN DE COPIAR ESTILO O PLAGIO
Opciones: "yo hablo asi, no me copio de nadie" / "siempre hable asi" / "es mi forma de hablar"

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
