const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
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
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI || 'https://storied-squirrel-fb5eea.netlify.app/callback'
);

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

app.get('/auth/url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.json({ url });
});

app.post('/auth/callback', async (req, res) => {
  const { code } = req.body;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    oauth2Client.setCredentials(tokens);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Error al obtener tokens', detail: err.message });
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!req.session.tokens });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: 'No autenticado' });
  oauth2Client.setCredentials(req.session.tokens);
  next();
}

app.get('/comments', requireAuth, async (req, res) => {
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const { pageToken } = req.query;
    const response = await youtube.commentThreads.list({
      part: ['snippet'],
      allThreadsRelatedToChannelId: process.env.YOUTUBE_CHANNEL_ID,
      moderationStatus: 'published',
      maxResults: 20,
      pageToken: pageToken || undefined
    });
    const comments = response.data.items.map(item => ({
      id: item.id,
      videoId: item.snippet.videoId,
      author: item.snippet.topLevelComment.snippet.authorDisplayName,
      avatar: item.snippet.topLevelComment.snippet.authorProfileImageUrl,
      text: item.snippet.topLevelComment.snippet.textDisplay,
      likes: item.snippet.topLevelComment.snippet.likeCount,
      publishedAt: item.snippet.topLevelComment.snippet.publishedAt,
      replyCount: item.snippet.totalReplyCount
    }));
    res.json({ comments, nextPageToken: response.data.nextPageToken || null });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener comentarios', detail: err.message });
  }
});

app.post('/comments/:id/reply', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { text, videoId } = req.body;
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    await youtube.comments.insert({ part: ['snippet'], requestBody: { snippet: { parentId: id, textOriginal: text, videoId } } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al responder', detail: err.message });
  }
});

app.post('/comments/:id/approve', requireAuth, async (req, res) => {
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    await youtube.comments.setModerationStatus({ id: [req.params.id], moderationStatus: 'published' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al aprobar', detail: err.message });
  }
});

app.post('/comments/:id/reject', requireAuth, async (req, res) => {
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    await youtube.comments.setModerationStatus({ id: [req.params.id], moderationStatus: 'rejected' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al rechazar', detail: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
