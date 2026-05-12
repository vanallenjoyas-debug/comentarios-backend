// v39 - AGENTE AUTÓNOMO
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const session = require('express-session');
const { Pool } = require('pg');
const agent = require('./agent');

const app = express();

app.use((req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    try {
      req.body = data ? JSON.parse(data.replace(/[\x00-\x1F\x7F]/g, ' ')) : {};
    } catch(e) {
      req.body = {};
    }
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

console.log("DB URL:", process.env.PG_URL || process.env.DATABASE_URL || "NO URL FOUND");
const pool = new Pool({ connectionString: process.env.PG_URL });

async function initDB() {
  console.log('initDB: iniciando CREATE TABLE...');
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
  console.log('initDB: CREATE TABLE ok. Chequeando columna source...');
  const colCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='comment_state' AND column_name='source'
  `);
  if (colCheck.rows.length === 0) {
    console.log('initDB: columna source no existe, agregando...');
    await pool.query(`ALTER TABLE comment_state ADD COLUMN source TEXT DEFAULT 'javi'`);
    console.log('initDB: columna source agregada.');
  } else {
    console.log('initDB: columna source ya existe, saltando ALTER TABLE.');
  }
  // Migración columna categoria
  const catCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='comment_state' AND column_name='categoria'
  `);
  if (catCheck.rows.length === 0) {
    console.log('initDB: agregando columna categoria...');
    await pool.query(`ALTER TABLE comment_state ADD COLUMN categoria TEXT DEFAULT 'otro'`);
    console.log('initDB: columna categoria agregada.');
  } else {
    console.log('initDB: columna categoria ya existe.');
  }
  console.log('DB lista - v37 - ' + new Date().toISOString());
}

async function getState() {
  const res = await pool.query(`SELECT id, status FROM comment_state`);
  const answered = res.rows.filter(r => r.status === 'answered').map(r => r.id);
  const discarded = res.rows.filter(r => r.status === 'discarded').map(r => r.id);
  return { answered, discarded };
}

async function markAnswered(id, commentText, replyText, videoTitle, source = 'javi') {
  await pool.query(`
    INSERT INTO comment_state (id, status, comment_text, reply_text, video_title, source)
    VALUES ($1, 'answered', $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET status='answered', reply_text=$3, video_title=$4, source=$5
  `, [id, commentText || '', replyText || '', videoTitle || '', source]);
}

async function markDiscarded(id) {
  await pool.query(`
    INSERT INTO comment_state (id, status)
    VALUES ($1, 'discarded')
    ON CONFLICT (id) DO UPDATE SET status='discarded'
  `, [id]);
}

async function getExamples(limit = 20, categoria = null) {
  // Si hay categoría, intentar traer ejemplos específicos primero
  if (categoria && categoria !== 'otro') {
    const res = await pool.query(`
      SELECT comment_text, reply_text, video_title FROM comment_state
      WHERE status = 'answered' AND comment_text != '' AND reply_text != ''
      AND (source = 'javi' OR source IS NULL)
      AND categoria = $2
      ORDER BY RANDOM() LIMIT $1
    `, [limit, categoria]);
    if (res.rows.length >= 5) return res.rows;
  }
  // Fallback: ejemplos aleatorios generales
  const res = await pool.query(`
    SELECT comment_text, reply_text, video_title FROM comment_state
    WHERE status = 'answered' AND comment_text != '' AND reply_text != ''
    AND (source = 'javi' OR source IS NULL)
    ORDER BY RANDOM() LIMIT $1
  `, [limit]);
  return res.rows;
}

const CATEGORIAS_VALIDAS = ['elogio','yeti_hibrido','sudaca','proceso','aprender','narracion','compra','curso','gracioso','contaminacion','otro'];

async function clasificarComentario(text) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: `Clasificá este comentario de un canal de joyería argentina en UNA categoría. Respondé SOLO la palabra clave.

Categorías:
- elogio (felicitaciones, le gusta el video, apoyo, buen trabajo)
- yeti_hibrido (lo llaman yeti, híbrido, parecido a alguien)
- sudaca (orgullo sudaca, joyería sudaca)
- proceso (preguntas sobre proceso técnico o químico)
- aprender (quieren aprender joyería, consejos para empezar)
- narracion (elogian cómo habla o explica)
- compra (quieren comprar, preguntan envío o precio)
- curso (preguntan por cursos o clases)
- contaminacion (preguntan o critican sobre contaminación, residuos, medio ambiente, daño ecológico, tirar químicos)
- gracioso (humor, chiste claro, comentario gracioso sin crítica)
- otro

IMPORTANTE: si el comentario mezcla humor con crítica ambiental o residuos, clasificar como "contaminacion" no "gracioso".

Comentario: "${text.substring(0, 200)}"` }]
      })
    });
    const data = await r.json();
    const cat = (data.content?.[0]?.text || '').trim().toLowerCase().split(/\s/)[0];
    return CATEGORIAS_VALIDAS.includes(cat) ? cat : 'otro';
  } catch(e) { return 'otro'; }
}

async function actualizarCategoria(id, categoria) {
  await pool.query(`UPDATE comment_state SET categoria = $2 WHERE id = $1`, [id, categoria]);
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
    const state = await getState();

    let allItems = [];
    let currentPageToken = pageToken || undefined;
    let lastNextPageToken = null;
    const MAX_YT_PAGES = 3;
    let pagesChecked = 0;

    while (pagesChecked < MAX_YT_PAGES) {
      const response = await youtube.commentThreads.list({
        part: 'snippet,replies',
        allThreadsRelatedToChannelId: process.env.YOUTUBE_CHANNEL_ID,
        maxResults: 50,
        order: 'time',
        pageToken: currentPageToken
      });
      allItems = [...allItems, ...(response.data.items || [])];
      lastNextPageToken = response.data.nextPageToken || null;
      pagesChecked++;

      const unanswered = allItems.filter(item => {
        const replies = item.replies?.comments || [];
        const answeredByMe = replies.some(r => r.snippet.authorChannelId?.value === MY_CHANNEL_ID);
        return !answeredByMe && !state.answered.includes(item.id) && !state.discarded.includes(item.id);
      });
      if (unanswered.length >= 20 || !lastNextPageToken) break;
      currentPageToken = lastNextPageToken;
    }

    const comments = allItems.map(item => {
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
        answered: answeredByMe || state.answered.includes(item.id),
        network: 'yt'
      };
    });

    // Ordenar: primero los no respondidos más nuevos, luego los respondidos
    comments.sort((a, b) => {
      if (a.answered !== b.answered) return a.answered ? 1 : -1;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    });

    console.log(`[yt/comments] ${pagesChecked} página(s), ${comments.filter(c=>!c.answered).length} sin responder`);
    res.json({ comments, nextPageToken: lastNextPageToken });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/comments/:id/reply', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { text, commentText } = req.body;
  console.log(`[reply] id=${id} text="${text}" commentText="${commentText}" userEdited=${req.body.userEdited} videoTitle="${req.body.videoTitle}"`);
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    console.log('[reply] llamando a youtube.comments.insert...');
    await youtube.comments.insert({
      part: 'snippet',
      requestBody: { snippet: { parentId: id, textOriginal: text } }
    });
    console.log('[reply] youtube ok. llamando a markAnswered...');
    const source = req.body.userEdited ? 'javi' : 'ai';
    await markAnswered(id, commentText || '', text, req.body.videoTitle || '', source);
    console.log('[reply] markAnswered ok. source=' + source);
    // Clasificar en background sin bloquear la respuesta
    if (source === 'javi' && commentText) {
      clasificarComentario(commentText).then(cat => actualizarCategoria(id, cat)).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[reply] ERROR:', e.message);
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
    const { pageToken, duration } = req.query;
    const baseParams = {
      part: 'snippet',
      channelId: process.env.YOUTUBE_CHANNEL_ID,
      type: 'video',
      order: 'date',
      maxResults: 50,
      pageToken: pageToken || undefined
    };

    let items = [];
    let nextPageToken = null;

    if (duration === 'long') {
      // Traer medium (4-20 min) y long (>20 min) en paralelo y combinar
      const [resMedium, resLong] = await Promise.all([
        youtube.search.list({ ...baseParams, videoDuration: 'medium' }),
        youtube.search.list({ ...baseParams, videoDuration: 'long' })
      ]);
      items = [...(resMedium.data.items || []), ...(resLong.data.items || [])];
      // Ordenar por fecha descendente
      items.sort((a, b) => new Date(b.snippet.publishedAt) - new Date(a.snippet.publishedAt));
      nextPageToken = resMedium.data.nextPageToken || resLong.data.nextPageToken || null;
    } else {
      const response = await youtube.search.list(baseParams);
      items = response.data.items || [];
      nextPageToken = response.data.nextPageToken || null;
    }

    const videos = items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.default?.url || ''
    }));
    res.json({ videos, nextPageToken });
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
        answeredByMe,
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

const FB_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_PAGE_ID = (process.env.FB_PAGE_ID || '').trim();
const IG_USER_ID = (process.env.IG_USER_ID || '').trim();
const IG_TOKEN = (process.env.IG_ACCESS_TOKEN || '').trim();

// Trae comentarios de un post, más nuevos primero
async function fetchAllPostComments(postId, token) {
  const url = `https://graph.facebook.com/v19.0/${postId}/comments?fields=id,message,from,created_time,comments{id,from}&limit=50&order=reverse_chronological&access_token=${token}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || !data.data) return [];
  return data.data;
}

app.get('/fb/comments', async (req, res) => {
  try {
    const { after } = req.query;
    const state = await getState();
    const comments = [];
    const seenIds = new Set();
    let nextCursor = null;
    let pageUrl = `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/posts?fields=id,message,created_time&limit=20&access_token=${FB_TOKEN}`;
    if (after) pageUrl += `&after=${after}`;
    let pagesChecked = 0;
    const MAX_PAGES = 5; // máximo 100 posts por request

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    while (pageUrl && pagesChecked < MAX_PAGES) {
      const r = await fetch(pageUrl);
      const data = await r.json();
      if (!r.ok) {
        console.error('FB error:', JSON.stringify(data));
        return res.status(500).json({ error: data.error?.message || 'Error de Facebook' });
      }

      const posts = data.data || [];
      const allPostComments = await Promise.all(posts.map(post => fetchAllPostComments(post.id, FB_TOKEN).then(cs => ({ post, cs }))));
      for (const { post, cs } of allPostComments) {
        for (const c of cs) {
          if (seenIds.has(c.id)) continue;
          if (new Date(c.created_time).getTime() < thirtyDaysAgo) continue;
          if (c.from?.id === FB_PAGE_ID) continue;
          const replies = c.comments?.data || [];
          const answeredByMe = replies.some(r => r.from?.id === FB_PAGE_ID);
          if (answeredByMe) continue;
          if (state.answered.includes(c.id) || state.discarded.includes(c.id)) continue;
          seenIds.add(c.id);
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

      nextCursor = data.paging?.cursors?.after || null;
      pageUrl = data.paging?.next || null;
      pagesChecked++;
    }

    // Agregar comentarios de reels
    const reelsResFB = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/video_reels?fields=id,description,title,name,created_time&limit=50&access_token=${FB_TOKEN}`);
    const reelsDataFB = await reelsResFB.json();
    if (reelsResFB.ok && reelsDataFB.data) {
      const allReelComments = await Promise.all(reelsDataFB.data.map(reel => fetchAllPostComments(reel.id, FB_TOKEN).then(cs => ({ reel, cs }))));
      for (const { reel, cs } of allReelComments) {
        for (const c of cs) {
          if (seenIds.has(c.id)) continue;
          if (new Date(c.created_time).getTime() < thirtyDaysAgo) continue;
          if (c.from?.id === FB_PAGE_ID) continue;
          const replies = c.comments?.data || [];
          const answeredByMe = replies.some(r => r.from?.id === FB_PAGE_ID);
          if (answeredByMe) continue;
          if (state.answered.includes(c.id) || state.discarded.includes(c.id)) continue;
          seenIds.add(c.id);
          comments.push({
            id: c.id,
            postId: reel.id,
            postMessage: reel.title || reel.name || reel.description || 'Reel sin título',
            text: c.message,
            author: c.from?.name || 'Usuario',
            authorPhoto: `https://graph.facebook.com/${c.from?.id}/picture?type=square`,
            publishedAt: c.created_time,
            network: 'fb'
          });
        }
      }
    }

    // Ordenar por más nuevos primero y devolver los primeros 20
    comments.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const top20 = comments.slice(0, 20);

    console.log(`[fb/comments] ${comments.length} encontrados en ${pagesChecked} página(s), devolviendo ${top20.length} más nuevos`);
    res.json({ comments: top20, nextCursor });
  } catch (e) {
    console.error('fb/comments error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/fb/comments/old', async (req, res) => {
  try {
    const state = await getState();
    const comments = [];
    const seenIds = new Set();
    let pageUrl = `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/posts?fields=id,message,created_time&limit=20&access_token=${FB_TOKEN}`;
    let pagesChecked = 0;
    const MAX_PAGES = 5;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    while (pageUrl && pagesChecked < MAX_PAGES) {
      const r = await fetch(pageUrl);
      const data = await r.json();
      if (!r.ok) return res.status(500).json({ error: data.error?.message || 'Error de Facebook' });

      const posts = data.data || [];
      const allPostComments = await Promise.all(posts.map(post => fetchAllPostComments(post.id, FB_TOKEN).then(cs => ({ post, cs }))));
      for (const { post, cs } of allPostComments) {
        for (const c of cs) {
          if (seenIds.has(c.id)) continue;
          if (new Date(c.created_time).getTime() >= thirtyDaysAgo) continue;
          if (c.from?.id === FB_PAGE_ID) continue;
          const replies = c.comments?.data || [];
          if (replies.some(r => r.from?.id === FB_PAGE_ID)) continue;
          if (state.answered.includes(c.id) || state.discarded.includes(c.id)) continue;
          seenIds.add(c.id);
          comments.push({ id: c.id, postId: post.id, postMessage: post.message || '', text: c.message, author: c.from?.name || 'Usuario', authorPhoto: `https://graph.facebook.com/${c.from?.id}/picture?type=square`, publishedAt: c.created_time, network: 'fb' });
        }
      }
      pageUrl = data.paging?.next || null;
      pagesChecked++;
    }

    const reelsRes = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/video_reels?fields=id,description,title,name,created_time&limit=50&access_token=${FB_TOKEN}`);
    const reelsData = await reelsRes.json();
    if (reelsRes.ok && reelsData.data) {
      const allReelComments = await Promise.all(reelsData.data.map(reel => fetchAllPostComments(reel.id, FB_TOKEN).then(cs => ({ reel, cs }))));
      for (const { reel, cs } of allReelComments) {
        for (const c of cs) {
          if (seenIds.has(c.id)) continue;
          if (new Date(c.created_time).getTime() >= thirtyDaysAgo) continue;
          if (c.from?.id === FB_PAGE_ID) continue;
          const replies = c.comments?.data || [];
          if (replies.some(r => r.from?.id === FB_PAGE_ID)) continue;
          if (state.answered.includes(c.id) || state.discarded.includes(c.id)) continue;
          seenIds.add(c.id);
          comments.push({ id: c.id, postId: reel.id, postMessage: reel.title || reel.name || reel.description || 'Reel sin título', text: c.message, author: c.from?.name || 'Usuario', authorPhoto: `https://graph.facebook.com/${c.from?.id}/picture?type=square`, publishedAt: c.created_time, network: 'fb' });
        }
      }
    }

    comments.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const top20 = comments.slice(0, 20);
    console.log(`[fb/comments/old] ${comments.length} encontrados, devolviendo ${top20.length}`);
    res.json({ comments: top20 });
  } catch (e) {
    console.error('fb/comments/old error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/fb/comments/:id/reply', async (req, res) => {
  const { id } = req.params;
  const { text, commentText } = req.body;
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
    const source = req.body.userEdited ? 'javi' : 'ai';
    await markAnswered(id, commentText || '', text, req.body.videoTitle || '', source);
    // Clasificar en background sin bloquear la respuesta
    if (source === 'javi' && commentText) {
      clasificarComentario(commentText).then(cat => actualizarCategoria(id, cat)).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('fb reply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function fetchIGMediaComments(mediaId, token) {
  const allComments = [];
  let url = `https://graph.instagram.com/v19.0/${mediaId}/comments?fields=id,text,username,timestamp&limit=50&access_token=${token}`;
  let page = 0;
  const MAX_PAGES = 10;
  while (url && page < MAX_PAGES) {
    const r = await fetch(url);
    const data = await r.json();
    console.log(`[ig/fetchComments] media=${mediaId} page=${page} ok=${r.ok} count=${data.data?.length ?? 'N/A'} error=${data.error?.message || 'none'}`);
    if (!r.ok || !data.data) break;
    allComments.push(...data.data);
    url = data.paging?.next || null;
    page++;
  }
  return allComments;
}

app.get('/ig/comments', async (req, res) => {
  // DESACTIVADO temporalmente — la integración IG está en revisión
  console.log('[ig/comments] endpoint desactivado temporalmente');
  res.json({ comments: [], nextCursor: null });
});

app.get('/ig/test-fb', async (req, res) => {
  try {
    // Paso 1: obtener IG Business Account ID desde la página de Facebook
    const pageRes = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}?fields=instagram_business_account&access_token=${FB_TOKEN}`);
    const pageData = await pageRes.json();
    console.log('[ig/test-fb] page:', JSON.stringify(pageData));
    const igAccountId = pageData.instagram_business_account?.id;
    if (!igAccountId) return res.json({ error: 'No IG business account linked', pageData });

    // Paso 2: traer media con ese ID
    const mediaRes = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/media?fields=id,caption,timestamp,comments_count&limit=5&access_token=${FB_TOKEN}`);
    const mediaData = await mediaRes.json();
    console.log('[ig/test-fb] media:', JSON.stringify(mediaData));
    if (!mediaData.data?.length) return res.json({ igAccountId, media: mediaData });

    // Paso 3: traer comentarios del primer post
    const firstMedia = mediaData.data[0];
    const commentsRes = await fetch(`https://graph.facebook.com/v19.0/${firstMedia.id}/comments?fields=id,text,username,timestamp&limit=10&access_token=${FB_TOKEN}`);
    const commentsData = await commentsRes.json();
    console.log('[ig/test-fb] comments:', JSON.stringify(commentsData));

    res.json({ igAccountId, firstMedia, comments: commentsData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/ig/comments/:id/reply', async (req, res) => {
  // DESACTIVADO temporalmente — la integración IG está en revisión
  console.log('[ig/reply] endpoint desactivado temporalmente');
  res.json({ ok: false, error: 'Instagram temporalmente desactivado' });
});

const makeComments = [];

app.post('/webhook/facebook-make', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const c = req.body;
  if (!c || !c.id) return res.status(400).json({ error: 'Datos invalidos' });
  const exists = makeComments.find(x => x.id === c.id);
  if (!exists) {
    makeComments.push({
      id: c.id, text: c.text || '', author: c.author || 'Usuario',
      authorId: c.authorId || '', postId: c.postId || '',
      publishedAt: c.publishedAt || new Date().toISOString(), network: 'fb'
    });
  }
  res.json({ ok: true });
});

app.get('/fb/make-comments', async (req, res) => {
  try {
    const state = await getState();
    const filtered = makeComments
      .filter(c => !state.discarded.includes(c.id))
      .map(c => ({ ...c, answered: state.answered.includes(c.id) }));
    res.json({ comments: filtered });
  } catch(e) {
    res.json({ comments: [] });
  }
});

app.get('/webhook/facebook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === 'sudaca2024') {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

app.post('/webhook/facebook', (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
});

app.post('/suggest-reply', async (req, res) => {
  const { comment, commentText } = req.body;
  if (!comment) return res.status(400).json({ error: 'Falta el comentario' });

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();

  let ejemplosBloque = '';
  try {
    const categoria = await clasificarComentario(comment);
    console.log(`[suggest] categoria detectada: ${categoria}`);
    const examples = await getExamples(20, categoria);
    console.log(`[suggest] ejemplos cargados: ${examples.length} (categoria: ${categoria})`);
    if (examples.length > 0) {
      ejemplosBloque = '\n\nAPRENDÉ EL TONO de estos ejemplos reales de Javi. No copies ninguno igual — usalos como guía de estilo:\n';
      examples.forEach((ex, i) => {
        ejemplosBloque += `\nEjemplo ${i+1}:${ex.video_title ? "\n(Video: "+ex.video_title+")" : ""}\nComentario: "${ex.comment_text}"\nRespuesta: "${ex.reply_text}"\n`;
      });
    }
  } catch(e) { console.log('[suggest] error cargando ejemplos:', e.message); }

  const prompt = `Sos Javi (Javier Romero), joyero argentino del canal Joyeria Sudaca. Tu tono es casual, directo, rioplatense natural — sin exagerar el acento, sin sonar a robot.${ejemplosBloque}

CATEGORÍAS Y VARIACIONES — elegí UNA al azar de la categoría que corresponda:

Elogios o felicitaciones:
- "muchas gracias me alegro que te guste mi contenido"
- "gracias por el aguante, me pone muy feliz que te guste"
- "muchas gracias bro, un abrazo grande"
- "gracias de verdad, me pone muy feliz que me digas esto"
- "increíble lo que me decís, muchas gracias por el aguante!!!"

Yeti / Híbrido:
- "jajaja me suelen decir que me parezco al yeti, es verdad"
- "HIBRIDOOO"
- "puede ser, la verdad que no sé qué hace que me parezca"
- "eso dicen jaja"
- "jajaja puede ser ehhh"
- "varios me dicen eso, es verdad!!!!"

Joyería Sudaca / aguante sudaca:
- "100% sudacas"
- "esto es joyería sudaca papá"
- "todos somos joyería sudaca"
- "claro que sí"

Cuestionan que no explico bien el proceso o piden más detalle:
- "este video no es un tutorial ni un curso, es una forma de hacer que más gente conozca el oficio"
- "un video de 30 segundos nunca jamás puede enseñar algo"
- "son videos entretenidos para que más gente conozca el oficio, no se puede hacer un curso en 30 segundos"

Quieren empezar en joyería / piden consejos:
- "si te lo proponés lo podés lograr, metele para adelante"
- "se empieza por el principio, metele y ya vas a lograr hacer tus primeras piezas"
- "metele, si te gusta el oficio siempre se puede aprender"

Elogian mi forma de narrar / el speech:
- "muchas gracias mi hermano, me pone contento que te guste la forma que tengo de explicar"
- "jaja me alegro bro, muchas gracias"
- "la verdad que sí, si me pongo a escuchar lo que digo es gracioso jaja"

REGLAS:
- Elegí UNA variación al azar — NUNCA la misma dos veces seguidas
- Podés inspirarte en las variaciones pero generá algo nuevo en ese mismo tono, no copies literal
- Emoji: aleatorio, ni siempre ni nunca. Opciones: 💪 🙌 👋 🔥 👍 🤷 😂 ⚡ 🫡 👌 😄 — variá siempre
- Respuesta CORTA, máximo 2 oraciones
- Nunca exagerar el acento
- Nunca explicar chistes ni justificarse
- Si preguntan por proceso técnico complejo → elegí AL AZAR: "Para más info escribime por privado 👋" / "Mandame un mensaje privado y te cuento" / "Por privado te paso más detalles 🙌"
- Si preguntan por cursos → elegí AL AZAR: "Mandame mensaje privado y te paso toda la info 👋" / "Por privado te mando los detalles 🙌" / "Escribime por privado bro 👋"
- Si preguntan por compra o envío → elegí AL AZAR: "Mandame un privado y vemos 👋" / "Escribime por privado 🙌" / "Mandame mensaje por inbox bro"
- NUNCA escribir "mandate", siempre "mandame"
- No inventar datos técnicos
- La marca es "Sudaca" con C, nunca con K
- Si el comentario es solo emojis → responder solo con emojis
- Comentario gracioso → reírse y nada más, nunca explicar el chiste
- Preguntan sobre contaminación, residuos o medio ambiente → elegí AL AZAR: "el proceso no contamina, los residuos se neutralizan y se almacenan para entregarlos a una empresa que se encarga de su neutralización final 💪" / "jamás tiramos nada al desagüe, todo se neutraliza y va a disposición final con empresa especializada 🙌" / "los residuos se neutralizan y se entregan a empresa de disposición final, el proceso está pensado para no contaminar 👋"
- "Es rentable?" → "Si tiene plata pero no es muy rentable de extraer"
- "Por qué no fundís directo?" → "Si solo fundimos no podemos garantizar la pureza del metal"
- Pepetools → "Está en mi bio, cupón vanallen 10% de descuento"
- Saludo desde otro país → variación de "me alegro que te guste el contenido, abrazo grande"

INSTRUCCIÓN: UNA SOLA respuesta lista para publicar, sin comillas ni explicaciones.
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
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Error de API' });
    }
    res.json({ suggestion: data.content?.[0]?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS DEL AGENTE AUTÓNOMO
// ═══════════════════════════════════════════════════════════════════════════════

// Disparar ciclo manualmente (también lo llama el cron)
app.post('/agent/run', async (req, res) => {
  const network = req.body?.network || 'fb';
  console.log(`[agent/run] disparado manualmente - network: ${network}`);
  try {
    const result = await agent.runAgent(network);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Estado y estadísticas del agente
app.get('/agent/stats', async (req, res) => {
  try {
    const stats = await agent.getAgentStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cola de revisión pendiente
app.get('/agent/queue', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM review_queue 
      WHERE status = 'pending' 
      ORDER BY confidence DESC, created_at DESC
    `);
    res.json({ queue: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 👍 Aprobar respuesta — postea en FB y aprende
app.post('/agent/approve', async (req, res) => {
  const { commentId, replyText } = req.body;
  if (!commentId || !replyText) return res.status(400).json({ error: 'Faltan datos' });
  try {
    await agent.approveReply(commentId, replyText);
    res.json({ ok: true, learned: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 👎 Rechazar — genera 3 variaciones nuevas
app.post('/agent/reject', async (req, res) => {
  const { commentId } = req.body;
  if (!commentId) return res.status(400).json({ error: 'Falta commentId' });
  try {
    const variations = await agent.rejectAndRegenerate(commentId);
    res.json({ ok: true, variations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Descartar un comentario de la cola (spam, irrelevante)
app.post('/agent/discard', async (req, res) => {
  const { commentId } = req.body;
  if (!commentId) return res.status(400).json({ error: 'Falta commentId' });
  try {
    await pool.query(`UPDATE review_queue SET status = 'discarded' WHERE id = $1`, [commentId]);
    await markDiscarded(commentId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Historial de runs del agente
app.get('/agent/runs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 20
    `);
    res.json({ runs: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Test de conexión Telegram
// Migración única — copia comment_state → reply_examples con source='historico'
app.post('/agent/migrate-history', async (req, res) => {
  try {
    const source = await pool.query(`
      SELECT id, comment_text, reply_text, video_title, categoria
      FROM comment_state
      WHERE status = 'answered'
        AND comment_text IS NOT NULL AND comment_text != ''
        AND reply_text IS NOT NULL AND reply_text != ''
        AND LENGTH(comment_text) > 2
        AND LENGTH(reply_text) > 2
    `);
    let inserted = 0, skipped = 0;
    for (const row of source.rows) {
      const exists = await pool.query(
        `SELECT id FROM reply_examples WHERE comment_text = $1 AND reply_text = $2 LIMIT 1`,
        [row.comment_text, row.reply_text]
      );
      if (exists.rows.length > 0) { skipped++; continue; }
      await pool.query(`
        INSERT INTO reply_examples (comment_text, reply_text, post_title, categoria, network, source, approved_at)
        VALUES ($1, $2, $3, $4, 'yt', 'historico', NOW())
      `, [row.comment_text, row.reply_text, row.video_title || '', row.categoria || 'otro']);
      inserted++;
    }
    const total = await pool.query(`SELECT COUNT(*) as cnt FROM reply_examples`);
    console.log(`[migrate] done — inserted: ${inserted}, skipped: ${skipped}, total: ${total.rows[0].cnt}`);
    res.json({ ok: true, inserted, skipped, total: parseInt(total.rows[0].cnt) });
  } catch (e) {
    console.error('[migrate] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});



// ═══════════════════════════════════════════════════════════════════════════════
// FAQ — preguntas frecuentes con respuestas canónicas y variaciones
// ═══════════════════════════════════════════════════════════════════════════════

// Inicializar tabla FAQ
async function initFAQ() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faq (
      id SERIAL PRIMARY KEY,
      pregunta TEXT NOT NULL,
      keywords TEXT NOT NULL,
      respuestas TEXT[] NOT NULL,
      activa BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Traer todas las FAQs activas
app.get('/agent/faq', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM faq WHERE activa = true ORDER BY created_at DESC');
    res.json({ faqs: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Crear nueva FAQ
app.post('/agent/faq', async (req, res) => {
  const { pregunta, keywords, respuestas } = req.body;
  if (!pregunta || !respuestas || respuestas.length === 0) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const result = await pool.query(
      'INSERT INTO faq (pregunta, keywords, respuestas) VALUES ($1, $2, $3) RETURNING *',
      [pregunta, keywords || pregunta, respuestas]
    );
    res.json({ ok: true, faq: result.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Editar FAQ
app.put('/agent/faq/:id', async (req, res) => {
  const { pregunta, keywords, respuestas } = req.body;
  try {
    await pool.query(
      'UPDATE faq SET pregunta=$1, keywords=$2, respuestas=$3 WHERE id=$4',
      [pregunta, keywords || pregunta, respuestas, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Eliminar FAQ
app.delete('/agent/faq/:id', async (req, res) => {
  try {
    await pool.query('UPDATE faq SET activa = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Buscar FAQ que matchee un comentario
app.post('/agent/faq/match', async (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ match: null });
  try {
    const faqs = await pool.query('SELECT * FROM faq WHERE activa = true');
    const text = comment.toLowerCase();
    let best = null;
    for (const faq of faqs.rows) {
      const keys = faq.keywords.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
      const matches = keys.filter(k => text.includes(k));
      if (matches.length > 0 && (!best || matches.length > best.matchCount)) {
        best = { ...faq, matchCount: matches.length };
      }
    }
    if (best) {
      const respuesta = best.respuestas[Math.floor(Math.random() * best.respuestas.length)];
      res.json({ match: true, faq: best, respuesta });
    } else {
      res.json({ match: false });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Agregar ejemplo de comentario a una FAQ para mejorar el matching
app.post('/agent/faq/:id/add-example', async (req, res) => {
  const { historyId } = req.body;
  try {
    const row = await pool.query('SELECT comment_text FROM comment_state WHERE id = $1', [historyId]);
    if (row.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    const commentText = row.rows[0].comment_text;
    await pool.query(`CREATE TABLE IF NOT EXISTS faq_examples (id SERIAL PRIMARY KEY, faq_id INT NOT NULL, comment_text TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query('INSERT INTO faq_examples (faq_id, comment_text) VALUES ($1, $2)', [req.params.id, commentText]);
    await pool.query('UPDATE comment_state SET source = $1 WHERE id = $2', ['ai_rated_fix', historyId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Historial de lo que auto-respondió el agente
app.get('/agent/history', async (req, res) => {
  try {
    // unrated=1 solo trae las sin calificar (para el historial de revisión)
    const unratedOnly = req.query.unrated === '1';
    const whereClause = unratedOnly 
      ? "WHERE source = 'ai'" 
      : "WHERE source IN ('ai','ai_rated_ok','ai_rated_fix')";
    const result = await pool.query(`
      SELECT id, comment_text, reply_text, 
             CASE WHEN video_title IS NULL OR video_title = '' OR LENGTH(video_title) < 5 
                  THEN '(sin título)' 
                  ELSE LEFT(video_title, 80) 
             END as video_title,
             post_url, created_at
      FROM comment_state
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json({ history: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// Borrar comentario del agente en FB
app.delete('/agent/history/:id/delete-fb', async (req, res) => {
  const { id } = req.params;
  try {
    // El id del comentario de respuesta no lo tenemos directamente
    // Borramos el comentario usando el FB Graph API
    // Primero buscamos el reply_id guardado, si no tenemos usamos el comment id
    const row = await pool.query('SELECT * FROM comment_state WHERE id = $1', [id]);
    if (row.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });

    // Intentar borrar el comentario de la página en FB
    // El agente responde creando un comentario hijo — necesitamos buscar ese ID
    // Por ahora borramos marcando como eliminado en la DB
    await pool.query("UPDATE comment_state SET source = 'ai_deleted' WHERE id = $1", [id]);
    
    // Intentar borrar via FB API — el comment ID original puede ser el parent
    const fbRes = await fetch(`https://graph.facebook.com/v19.0/${id}?access_token=${FB_TOKEN}`, {
      method: 'DELETE'
    });
    const fbData = await fbRes.json();
    
    if (fbData.success || fbData.error?.code === 100) {
      // Deleted or already gone
      res.json({ ok: true, deleted: true });
    } else {
      // Can't delete parent, but mark as deleted in our DB
      console.log('[delete-fb] FB response:', JSON.stringify(fbData));
      res.json({ ok: true, deleted: false, message: 'Marcado como eliminado en la app. Borralo manualmente en FB.' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Calificar respuesta del historial
app.post('/agent/history/:id/rate', async (req, res) => {
  const { id } = req.params;
  const { rating, correction } = req.body; // rating: 'ok' | 'mejorable' | 'mal'
  try {
    const row = await pool.query('SELECT * FROM comment_state WHERE id = $1', [id]);
    if (row.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    const item = row.rows[0];

    if (rating === 'ok') {
      // Refuerza el aprendizaje — sube peso del ejemplo
      await pool.query(`
        INSERT INTO reply_examples (comment_text, reply_text, post_title, network, source, approved_at)
        VALUES ($1, $2, $3, 'fb', 'agente', NOW())
        ON CONFLICT DO NOTHING
      `, [item.comment_text, item.reply_text, item.video_title || '']);
    }

    if ((rating === 'mejorable' || rating === 'mal') && correction) {
      // Guarda la corrección de Javi como ejemplo prioritario
      await pool.query(`
        INSERT INTO reply_examples (comment_text, reply_text, post_title, network, source, approved_at)
        VALUES ($1, $2, $3, 'fb', 'agente', NOW())
      `, [item.comment_text, correction, item.video_title || '']);
      // Elimina la versión mala del aprendizaje
      await pool.query(`
        DELETE FROM reply_examples WHERE comment_text = $1 AND reply_text = $2
      `, [item.comment_text, item.reply_text]);
    }

    // Marcar como calificado para que desaparezca del historial
    await pool.query(`UPDATE comment_state SET source = $1 WHERE id = $2`, 
      [rating === 'ok' ? 'ai_rated_ok' : 'ai_rated_fix', id]);

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Marcar auto-respuesta como mala — la saca del aprendizaje
app.post('/agent/history/:id/reject', async (req, res) => {
  const { id } = req.params;
  try {
    // Cambiar source a 'ai_rejected' para excluirla del aprendizaje
    await pool.query(
      `UPDATE comment_state SET source = 'ai_rejected' WHERE id = $1`,
      [id]
    );
    // Eliminarla de reply_examples si existe
    const row = await pool.query('SELECT comment_text, reply_text FROM comment_state WHERE id = $1', [id]);
    if (row.rows.length > 0) {
      await pool.query(
        'DELETE FROM reply_examples WHERE comment_text = $1 AND reply_text = $2',
        [row.rows[0].comment_text, row.rows[0].reply_text]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/agent/telegram-test', async (req, res) => {
  try {
    await agent.sendTelegram('🤖 Conexión con el agente de comentarios OK. Todo funcionando.');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CRON INTERNO — cada 2 horas corre el agente automáticamente
// ═══════════════════════════════════════════════════════════════════════════════

function startCron() {
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  const runCycle = async () => {
    try {
      console.log('[cron] ▶ ciclo automático iniciado');
      await agent.runAgent('fb');
    } catch (e) {
      console.error('[cron] error en ciclo:', e.message);
    }
  };

  // Primera corrida 2 minutos después de iniciar (no en el arranque para evitar problemas)
  setTimeout(() => {
    runCycle();
    setInterval(runCycle, TWO_HOURS);
  }, 2 * 60 * 1000);

  console.log('[cron] programado — primer ciclo en 2 minutos, luego cada 2 horas');
}

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  Promise.all([initDB(), agent.initAgentDB(), initFAQ()])
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Servidor corriendo en puerto ${PORT}`);
        startCron();
      });
    })
    .catch(e => {
      console.error('Error iniciando DB:', e.message);
      app.listen(PORT, () => {
        console.log(`Servidor corriendo sin DB en puerto ${PORT}`);
        startCron();
      });
    });
}

module.exports = { app, initDB, getState, markAnswered, markDiscarded, getExamples };
