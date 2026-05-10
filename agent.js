// AGENTE AUTÓNOMO DE COMENTARIOS - v1
// Se corre cada 2hs via cron interno
// Aprende de cada 👍 que hace Javi

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.PG_URL });

const FB_PAGE_ID = (process.env.FB_PAGE_ID || '').trim();
const FB_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── DB SETUP ────────────────────────────────────────────────────────────────

async function initAgentDB() {
  // Contexto por video/post: qué tipo de contenido es, qué comentarios recibe
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_context (
      post_id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      content_type TEXT DEFAULT 'general',
      typical_comments TEXT,
      last_updated TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Ejemplos aprobados por Javi (👍) — el corazón del aprendizaje
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reply_examples (
      id SERIAL PRIMARY KEY,
      comment_text TEXT NOT NULL,
      reply_text TEXT NOT NULL,
      post_id TEXT,
      post_title TEXT,
      categoria TEXT DEFAULT 'otro',
      network TEXT DEFAULT 'fb',
      approved_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Log de cada corrida del agente
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      network TEXT DEFAULT 'fb',
      comments_fetched INT DEFAULT 0,
      comments_auto_replied INT DEFAULT 0,
      comments_queued INT DEFAULT 0,
      comments_skipped INT DEFAULT 0,
      error TEXT
    )
  `);

  // Cola de revisión: comentarios que el agente no supo resolver con confianza
  await pool.query(`
    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY,
      comment_text TEXT,
      post_id TEXT,
      post_title TEXT,
      author TEXT,
      network TEXT DEFAULT 'fb',
      suggested_reply TEXT,
      confidence FLOAT DEFAULT 0,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('[agent] DB tables ok');
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('[telegram] error:', e.message);
  }
}

// ─── CONTEXTO DEL VIDEO/POST ──────────────────────────────────────────────────

async function getOrBuildPostContext(postId, postMessage, network) {
  // Ver si ya tenemos contexto guardado
  const existing = await pool.query(
    `SELECT * FROM video_context WHERE post_id = $1`, [postId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  // Buscar ejemplos previos de este post para entender qué tipo de comentarios recibe
  const examples = await pool.query(
    `SELECT comment_text, reply_text FROM reply_examples WHERE post_id = $1 LIMIT 10`, [postId]
  );

  // Construir contexto automáticamente con Claude
  const contextPrompt = `Analizá este post de un joyero argentino (canal Joyería Sudaca) y describí brevemente:
1. De qué trata (1 línea)
2. Qué tipo de comentarios suele recibir (1 línea)
3. Categoría del contenido: proceso_quimico | proceso_taller | herramientas | curso_info | general

Mensaje del post: "${(postMessage || '').substring(0, 300)}"
${examples.rows.length > 0 ? `\nComentarios previos en este post:\n${examples.rows.map(e => `- "${e.comment_text}"`).join('\n')}` : ''}

Respondé SOLO en formato JSON:
{"title":"...","typical_comments":"...","content_type":"..."}`;

  let contextData = { title: postMessage?.substring(0, 60) || postId, typical_comments: 'variados', content_type: 'general' };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        messages: [{ role: 'user', content: contextPrompt }]
      })
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    contextData = { ...contextData, ...JSON.parse(clean) };
  } catch (e) {
    console.log('[agent] context build error:', e.message);
  }

  // Guardar para siempre
  await pool.query(`
    INSERT INTO video_context (post_id, title, description, content_type, typical_comments)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (post_id) DO UPDATE SET 
      typical_comments=$5, last_updated=NOW()
  `, [postId, contextData.title, postMessage || '', contextData.content_type, contextData.typical_comments]);

  return contextData;
}

// ─── EJEMPLOS DE APRENDIZAJE ──────────────────────────────────────────────────

async function getLearnedExamples(postId, comentario, limit = 15) {
  // Primero: ejemplos del mismo post (los más relevantes)
  const postExamples = await pool.query(`
    SELECT comment_text, reply_text, post_title FROM reply_examples
    WHERE post_id = $1
    ORDER BY approved_at DESC LIMIT 8
  `, [postId]);

  // Segundo: ejemplos generales de categoría similar
  const generalExamples = await pool.query(`
    SELECT comment_text, reply_text, post_title FROM reply_examples
    ORDER BY approved_at DESC LIMIT $1
  `, [limit]);

  const all = [...postExamples.rows, ...generalExamples.rows];
  // Deduplicar
  const seen = new Set();
  return all.filter(e => {
    if (seen.has(e.comment_text)) return false;
    seen.add(e.comment_text);
    return true;
  }).slice(0, limit);
}

// ─── GENERADOR DE RESPUESTA ───────────────────────────────────────────────────

async function generateReply(comment, postContext, examples) {
  const examplesBlock = examples.length > 0
    ? `\nEJEMPLOS REALES APROBADOS POR JAVI (aprendé el tono, no copies literal):\n` +
      examples.map((e, i) => `${i + 1}. Comentario: "${e.comment_text}"\n   Respuesta: "${e.reply_text}"`).join('\n')
    : '';

  const contextBlock = postContext
    ? `\nCONTEXTO DEL POST: ${postContext.title || ''} | Tipo: ${postContext.content_type || 'general'} | Comentarios típicos: ${postContext.typical_comments || ''}`
    : '';

  const prompt = `Sos Javi (Javier Romero), joyero argentino del canal Joyería Sudaca. Tono casual, directo, rioplatense natural.
${contextBlock}
${examplesBlock}

REGLAS FIJAS:
- Respuesta CORTA, máximo 2 oraciones
- Emoji: opcional y variado (💪 🙌 👋 🔥 👍 🤷 😂 ⚡ 🫡 👌 😄)
- Nunca exagerar el acento, nunca sonar a robot
- Nunca explicar chistes
- Si preguntan proceso técnico complejo → "Por privado te cuento 👋" o variación
- Si preguntan curso → "Mandame mensaje privado y te paso info 👋" o variación
- Si preguntan compra → "Escribime por privado 🙌" o variación
- Si comentario es solo emojis → responder solo emojis
- Pepetools → "Está en mi bio, cupón vanallen 10% de descuento"
- La marca es "Sudaca" con C nunca con K
- NUNCA escribir "mandate", siempre "mandame"
- Si el post es sobre una técnica específica (ej: pulidora de agujas, ácido, ciclón) y el comentario da consejos no pedidos → responder con humor breve sin invalidar al usuario
- Generá UNA respuesta lista para publicar, sin comillas ni explicaciones

Comentario a responder: "${comment}"`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error('[agent] generateReply error:', e.message);
    return null;
  }
}

// ─── CALCULAR CONFIANZA ───────────────────────────────────────────────────────

async function calculateConfidence(comment, postId) {
  // Confianza alta si:
  // 1. Tenemos ejemplos previos del mismo post
  // 2. Es una categoría conocida (elogio, yeti, sudaca, etc)
  // 3. El comentario no es una pregunta técnica compleja

  const postExamples = await pool.query(
    `SELECT COUNT(*) as cnt FROM reply_examples WHERE post_id = $1`, [postId]
  );
  const postExampleCount = parseInt(postExamples.rows[0].cnt);

  const totalExamples = await pool.query(`SELECT COUNT(*) as cnt FROM reply_examples`);
  const total = parseInt(totalExamples.rows[0].cnt);

  // Base: ejemplos generales disponibles
  let confidence = Math.min(0.5, total / 100);

  // Bonus: ejemplos específicos de este post
  if (postExampleCount > 0) confidence += 0.2;
  if (postExampleCount > 5) confidence += 0.1;

  // Bonus: patrones simples que siempre funcionan
  const simplePatterns = [
    /yeti|híbrido|hibrido/i,
    /🔥|💪|👏|❤️/,
    /joyería sudaca|sudaca/i,
    /genial|excelente|increíble|buenísimo/i,
    /de donde sos|argentina/i
  ];
  if (simplePatterns.some(p => p.test(comment))) confidence += 0.25;

  // Penalización: preguntas técnicas complejas o comentarios largos
  if (comment.length > 200) confidence -= 0.1;
  if (/\?.*\?.*\?/.test(comment)) confidence -= 0.15; // múltiples preguntas

  return Math.max(0.1, Math.min(0.95, confidence));
}

// ─── POSTEAR RESPUESTA EN FB ──────────────────────────────────────────────────

async function postFBReply(commentId, text) {
  const r = await fetch(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: text, access_token: FB_TOKEN })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'FB reply error');
  return data;
}

// ─── GUARDAR EN comment_state (compatible con sistema existente) ──────────────

async function saveAsAnswered(id, commentText, replyText, videoTitle) {
  await pool.query(`
    INSERT INTO comment_state (id, status, comment_text, reply_text, video_title, source)
    VALUES ($1, 'answered', $2, $3, $4, 'ai')
    ON CONFLICT (id) DO UPDATE SET status='answered', reply_text=$3, video_title=$4, source='ai'
  `, [id, commentText || '', replyText || '', videoTitle || '']);
}

// ─── CICLO PRINCIPAL DEL AGENTE ───────────────────────────────────────────────

async function runAgent(network = 'fb') {
  console.log(`[agent] ▶ INICIO ciclo ${network} - ${new Date().toISOString()}`);

  // Log de inicio
  const runResult = await pool.query(
    `INSERT INTO agent_runs (network) VALUES ($1) RETURNING id`, [network]
  );
  const runId = runResult.rows[0].id;

  let fetched = 0, autoReplied = 0, queued = 0, skipped = 0;

  try {
    // ── 1. TRAER COMENTARIOS ──────────────────────────────────────────────────
    const state = await pool.query(`SELECT id, status FROM comment_state`);
    const answeredIds = new Set(state.rows.filter(r => r.status === 'answered').map(r => r.id));
    const discardedIds = new Set(state.rows.filter(r => r.status === 'discarded').map(r => r.id));

    // También chequear review_queue para no procesar dos veces
    const inQueue = await pool.query(`SELECT id FROM review_queue WHERE status = 'pending'`);
    const queuedIds = new Set(inQueue.rows.map(r => r.id));

    let comments = [];

    if (network === 'fb') {
      comments = await fetchFBComments(answeredIds, discardedIds, queuedIds);
    }
    // YT se puede agregar después con el mismo patrón

    fetched = comments.length;
    console.log(`[agent] comentarios nuevos a procesar: ${fetched}`);

    if (fetched === 0) {
      await finishRun(runId, 0, 0, 0, 0);
      console.log('[agent] nada nuevo, saliendo');
      return { fetched: 0, autoReplied: 0, queued: 0, skipped: 0 };
    }

    // ── 2. AGRUPAR COMENTARIOS SIMILARES POR POST ─────────────────────────────
    const byPost = {};
    for (const c of comments) {
      if (!byPost[c.postId]) byPost[c.postId] = [];
      byPost[c.postId].push(c);
    }

    // ── 3. PROCESAR CADA COMENTARIO ───────────────────────────────────────────
    for (const [postId, postComments] of Object.entries(byPost)) {
      const firstComment = postComments[0];

      // Construir/recuperar contexto del post
      const postContext = await getOrBuildPostContext(postId, firstComment.postMessage, network);

      // Agrupar similares dentro del post (para no responder 50 veces lo mismo)
      const processed = new Set();

      for (const comment of postComments) {
        if (processed.has(comment.id)) continue;

        // Buscar ejemplos aprendidos
        const examples = await getLearnedExamples(postId, comment.text);

        // Calcular confianza
        const confidence = await calculateConfidence(comment.text, postId);

        // Generar respuesta
        const reply = await generateReply(comment.text, postContext, examples);

        if (!reply) {
          skipped++;
          processed.add(comment.id);
          continue;
        }

        if (confidence >= 0.65) {
          // ── AUTO-RESPONDER ──────────────────────────────────────────────────
          try {
            await postFBReply(comment.id, reply);
            await saveAsAnswered(comment.id, comment.text, reply, postContext.title);
            autoReplied++;
            console.log(`[agent] ✅ auto-respondido: "${comment.text.substring(0, 50)}..."`);
          } catch (e) {
            console.error(`[agent] error posteando:`, e.message);
            // Si falla el posteo, mandar a cola de revisión
            await addToQueue(comment, postContext, reply, confidence, 'error_posteo');
            queued++;
          }
        } else {
          // ── MANDAR A COLA DE REVISIÓN ───────────────────────────────────────
          await addToQueue(comment, postContext, reply, confidence, 'baja_confianza');
          queued++;
          console.log(`[agent] 👁️ en cola (conf=${confidence.toFixed(2)}): "${comment.text.substring(0, 50)}..."`);
        }

        processed.add(comment.id);

        // Pequeña pausa para no saturar la API
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // ── 4. NOTIFICAR POR TELEGRAM ─────────────────────────────────────────────
    const msg = `🤖 <b>Agente de comentarios - ciclo completado</b>

📥 Comentarios procesados: <b>${fetched}</b>
✅ Respondidos automáticamente: <b>${autoReplied}</b>
👁️ En cola para revisión: <b>${queued}</b>
⏭️ Saltados: <b>${skipped}</b>

${queued > 0 ? `⚠️ Tenés <b>${queued} comentarios</b> esperando tu revisión en el panel.` : '✨ Sin pendientes, todo en orden.'}`;

    await sendTelegram(msg);

    await finishRun(runId, fetched, autoReplied, queued, skipped);
    console.log(`[agent] ▶ FIN ciclo - auto:${autoReplied} cola:${queued} skip:${skipped}`);

    return { fetched, autoReplied, queued, skipped };

  } catch (e) {
    console.error('[agent] ERROR en ciclo:', e.message);
    await pool.query(`UPDATE agent_runs SET finished_at=NOW(), error=$2 WHERE id=$1`, [runId, e.message]);
    await sendTelegram(`❌ <b>Error en agente de comentarios</b>\n${e.message}`);
    throw e;
  }
}

// ─── FETCH FB COMMENTS ────────────────────────────────────────────────────────

async function fetchFBComments(answeredIds, discardedIds, queuedIds) {
  const comments = [];
  const seenIds = new Set();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  try {
    // Posts
    let pageUrl = `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/posts?fields=id,message,created_time&limit=10&access_token=${FB_TOKEN}`;
    let pagesChecked = 0;
    const MAX_PAGES = 3;

    while (pageUrl && pagesChecked < MAX_PAGES) {
      const r = await fetch(pageUrl);
      const data = await r.json();
      if (!r.ok || !data.data) break;

      for (const post of data.data) {
        const cs = await fetchAllPostComments(post.id);
        for (const c of cs) {
          if (seenIds.has(c.id)) continue;
          if (new Date(c.created_time).getTime() < thirtyDaysAgo) continue;
          if (c.from?.id === FB_PAGE_ID) continue;
          if (answeredIds.has(c.id) || discardedIds.has(c.id) || queuedIds.has(c.id)) continue;
          const replies = c.comments?.data || [];
          if (replies.some(r => r.from?.id === FB_PAGE_ID)) continue;
          seenIds.add(c.id);
          comments.push({
            id: c.id,
            postId: post.id,
            postMessage: post.message || '',
            text: c.message || '',
            author: c.from?.name || 'Usuario',
            publishedAt: c.created_time,
            network: 'fb'
          });
        }
      }

      pageUrl = data.paging?.next || null;
      pagesChecked++;
    }

    // Reels
    const reelsRes = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/video_reels?fields=id,description,created_time&limit=20&access_token=${FB_TOKEN}`);
    const reelsData = await reelsRes.json();
    if (reelsRes.ok && reelsData.data) {
      for (const reel of reelsData.data) {
        const cs = await fetchAllPostComments(reel.id);
        for (const c of cs) {
          if (seenIds.has(c.id)) continue;
          if (new Date(c.created_time).getTime() < thirtyDaysAgo) continue;
          if (c.from?.id === FB_PAGE_ID) continue;
          if (answeredIds.has(c.id) || discardedIds.has(c.id) || queuedIds.has(c.id)) continue;
          const replies = c.comments?.data || [];
          if (replies.some(r => r.from?.id === FB_PAGE_ID)) continue;
          seenIds.add(c.id);
          comments.push({
            id: c.id,
            postId: reel.id,
            postMessage: reel.description || '',
            text: c.message || '',
            author: c.from?.name || 'Usuario',
            publishedAt: c.created_time,
            network: 'fb'
          });
        }
      }
    }
  } catch (e) {
    console.error('[agent/fetchFB] error:', e.message);
  }

  // Más nuevos primero, máximo 30 por ciclo para no saturar
  comments.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return comments.slice(0, 30);
}

async function fetchAllPostComments(postId) {
  const url = `https://graph.facebook.com/v19.0/${postId}/comments?fields=id,message,from,created_time,comments{id,from}&limit=50&order=reverse_chronological&access_token=${FB_TOKEN}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || !data.data) return [];
  return data.data;
}

// ─── COLA DE REVISIÓN ─────────────────────────────────────────────────────────

async function addToQueue(comment, postContext, suggestedReply, confidence, reason) {
  await pool.query(`
    INSERT INTO review_queue (id, comment_text, post_id, post_title, author, network, suggested_reply, confidence, reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (id) DO NOTHING
  `, [
    comment.id,
    comment.text,
    comment.postId,
    postContext?.title || '',
    comment.author,
    comment.network || 'fb',
    suggestedReply,
    confidence,
    reason
  ]);
}

// ─── APRENDIZAJE: APROBAR RESPUESTA (👍) ──────────────────────────────────────

async function approveReply(commentId, finalReplyText) {
  // Traer datos de la cola
  const q = await pool.query(`SELECT * FROM review_queue WHERE id = $1`, [commentId]);
  if (q.rows.length === 0) return;
  const item = q.rows[0];

  // Guardar como ejemplo aprobado — esto alimenta al agente para siempre
  await pool.query(`
    INSERT INTO reply_examples (comment_text, reply_text, post_id, post_title, network)
    VALUES ($1, $2, $3, $4, $5)
  `, [item.comment_text, finalReplyText, item.post_id, item.post_title, item.network]);

  // Marcar como procesado en la cola
  await pool.query(`UPDATE review_queue SET status = 'approved' WHERE id = $1`, [commentId]);

  // Marcar como respondido en el sistema principal
  await saveAsAnswered(commentId, item.comment_text, finalReplyText, item.post_title);

  // Postear en FB
  await postFBReply(commentId, finalReplyText);

  console.log(`[agent] 👍 aprendido: "${item.comment_text.substring(0, 50)}"`);
}

// ─── RECHAZAR Y REGENERAR (👎) ────────────────────────────────────────────────

async function rejectAndRegenerate(commentId) {
  const q = await pool.query(`SELECT * FROM review_queue WHERE id = $1`, [commentId]);
  if (q.rows.length === 0) return [];
  const item = q.rows[0];

  const postContext = await pool.query(`SELECT * FROM video_context WHERE post_id = $1`, [item.post_id]);
  const examples = await getLearnedExamples(item.post_id, item.comment_text);

  // Generar 3 variaciones distintas
  const variations = [];
  for (let i = 0; i < 3; i++) {
    const v = await generateReply(item.comment_text, postContext.rows[0], examples);
    if (v && !variations.includes(v)) variations.push(v);
    await new Promise(r => setTimeout(r, 300));
  }

  return variations;
}

// ─── FINISH RUN ───────────────────────────────────────────────────────────────

async function finishRun(runId, fetched, autoReplied, queued, skipped) {
  await pool.query(`
    UPDATE agent_runs SET 
      finished_at=NOW(), 
      comments_fetched=$2, 
      comments_auto_replied=$3, 
      comments_queued=$4,
      comments_skipped=$5
    WHERE id=$1
  `, [runId, fetched, autoReplied, queued, skipped]);
}

// ─── ESTADÍSTICAS ─────────────────────────────────────────────────────────────

async function getAgentStats() {
  const runs = await pool.query(`
    SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 10
  `);
  const examples = await pool.query(`SELECT COUNT(*) as cnt FROM reply_examples`);
  const pending = await pool.query(`SELECT COUNT(*) as cnt FROM review_queue WHERE status = 'pending'`);
  const totalAutoReplied = await pool.query(`
    SELECT COALESCE(SUM(comments_auto_replied), 0) as total FROM agent_runs
  `);

  return {
    recent_runs: runs.rows,
    total_learned_examples: parseInt(examples.rows[0].cnt),
    pending_review: parseInt(pending.rows[0].cnt),
    total_auto_replied: parseInt(totalAutoReplied.rows[0].total)
  };
}

module.exports = {
  initAgentDB,
  runAgent,
  approveReply,
  rejectAndRegenerate,
  getAgentStats,
  addToQueue,
  sendTelegram
};
