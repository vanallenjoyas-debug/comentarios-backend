// AGENTE AUTÓNOMO - v2 LIMPIO
// Responde SOLO las categorías acordadas. Todo lo demás se ignora.

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.PG_URL });

const FB_PAGE_ID = (process.env.FB_PAGE_ID || '').trim();
const FB_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;

// ─── RESPUESTAS POR CATEGORÍA ─────────────────────────────────────────────────

const RESPUESTAS = {
  elogio: [
    'muchas gracias bro, me pone muy feliz que te guste 🙌',
    'gracias por el aguante, me alegra un montón 💪',
    'gracias de verdad, me pone muy feliz que me digas eso 😄',
    'muchas gracias hermano, abrazo grande 🙌',
    'increíble lo que me decís, gracias por el aguante!!! 💪'
  ],
  yeti: [
    'HIBRIDOOOO 💪',
    'eso dicen jaja 😄',
    'varios me dicen eso, es verdad!!!!',
    'puede ser ehhh 😂',
    'jajaja me suelen decir que me parezco a alguien'
  ],
  sudaca: [
    'esto es joyería sudaca papá 🔥',
    '100% sudacas 💪',
    'todos somos joyería sudaca papá',
    'claro que sí, sudaca al mango 🔥'
  ],
  curso: [
    'Mandame mensaje privado y te paso toda la info 👋',
    'Escribime por privado bro 👋',
    'Por privado te mando los detalles 🙌',
    'Mandame un privado y te cuento todo 💪'
  ],
  gracioso: [
    'jajaja top comment 😂',
    'jajaja me alegra que te cause gracia, se hace lo que se puede 😄',
    'jajajaja 😂',
    'jaja buena esa 😂'
  ],
  residuos: [
    'el ácido se neutraliza y se almacena para luego entregarlo a una empresa que se encarga de su neutralización final 💪',
    'jamás al desagüe, se neutraliza y va a disposición final con empresa especializada 🙌',
    'los residuos se neutralizan y se entregan a empresa de disposición final, el proceso está pensado para no contaminar 👋'
  ],
  no_metal: [
    'no, no vendo metal mi amigo 🤷',
    'no vendo metal bro, solo joyas y cursos 🙏',
    'gracias por tenerme en cuenta pero no, metal no vendo 🙏'
  ],
  compra_joya: [
    'Mandame un privado y vemos 👋',
    'Escribime por privado 🙌',
    'Mandame mensaje por inbox bro 👋'
  ],
  oro_electronica: [
    'no, no refino oro de chatarra electrónica, no es rentable lamentablemente salvo que tengas cantidades muy grandes 🤷',
    'ese proceso no lo hago bro, a baja escala no es rentable 🤷',
    'no es un proceso rentable y es muy contaminante 🤷'
  ]
};

function getRespuesta(categoria) {
  const lista = RESPUESTAS[categoria];
  if (!lista || lista.length === 0) return null;
  return lista[Math.floor(Math.random() * lista.length)];
}

// ─── DB SETUP ─────────────────────────────────────────────────────────────────

async function initAgentDB() {
  // Tabla de categorías con variaciones y exclusiones manejadas desde el panel
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_categories (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL UNIQUE,
      respuestas TEXT[] NOT NULL DEFAULT '{}',
      exclusiones TEXT[] NOT NULL DEFAULT '{}',
      activa BOOLEAN DEFAULT true,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // FAQ
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

  // FAQ ejemplos de matching
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faq_examples (
      id SERIAL PRIMARY KEY,
      faq_id INT NOT NULL,
      comment_text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Log de corridas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      network TEXT DEFAULT 'fb',
      comments_fetched INT DEFAULT 0,
      comments_auto_replied INT DEFAULT 0,
      comments_queued INT DEFAULT 0,
      comments_ignored INT DEFAULT 0,
      error TEXT
    )
  `);

  // Inicializar categorías con los valores acordados si no existen
  const cats = [
    { nombre: 'elogio', respuestas: RESPUESTAS.elogio, exclusiones: [] },
    { nombre: 'yeti', respuestas: RESPUESTAS.yeti, exclusiones: [] },
    { nombre: 'sudaca', respuestas: RESPUESTAS.sudaca, exclusiones: [] },
    { nombre: 'curso', respuestas: RESPUESTAS.curso, exclusiones: [] },
    { nombre: 'gracioso', respuestas: RESPUESTAS.gracioso, exclusiones: [] },
    { nombre: 'residuos', respuestas: RESPUESTAS.residuos, exclusiones: [] },
    { nombre: 'no_metal', respuestas: RESPUESTAS.no_metal, exclusiones: [] },
    { nombre: 'compra_joya', respuestas: RESPUESTAS.compra_joya, exclusiones: [] },
    { nombre: 'oro_electronica', respuestas: RESPUESTAS.oro_electronica, exclusiones: [] }
  ];

  for (const cat of cats) {
    await pool.query(`
      INSERT INTO agent_categories (nombre, respuestas, exclusiones)
      VALUES ($1, $2, $3)
      ON CONFLICT (nombre) DO NOTHING
    `, [cat.nombre, cat.respuestas, cat.exclusiones]);
  }

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
  } catch(e) { console.error('[telegram] error:', e.message); }
}

// ─── DETECCIÓN DE CATEGORÍA ───────────────────────────────────────────────────

function soloEmojis(text) {
  // Elimina emojis y espacios y ve si queda algo
  const sinEmojis = text.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\uD800-\uDFFF\u2000-\u206F\u2700-\u27BF ]/gu, '').trim();
  return sinEmojis.length === 0 && text.trim().length > 0;
}

function detectarHardcode(text) {
  const t = text.toLowerCase();

  // Emojis solos
  if (soloEmojis(text)) return 'emoji';

  // Yeti/híbrido
  if (/h[ií]brido|yeti|bruta\s*cocina|brutacocina|se parece/i.test(text)) return 'yeti';

  // Sudaca
  if (/sudaca|sudaka|joyería sudaca|josheria/i.test(text)) return 'sudaca';

  // Curso
  if (/^curso$/i.test(text.trim()) ||
      /\bcurso\b|\binfo\b|\binformaci[oó]n\b|\bme interesa\b|\bquiero aprender\b|\bquiero saber\b|\bclases\b/i.test(t)) return 'curso';

  return null;
}

async function detectarConHaiku(text, categorias) {
  // Carga las categorías de la DB (con exclusiones actualizadas)
  const catRows = await pool.query(`SELECT * FROM agent_categories WHERE activa = true`);
  const catMap = {};
  for (const row of catRows.rows) {
    catMap[row.nombre] = row;
  }

  // También chequea FAQs
  const faqs = await pool.query(`SELECT * FROM faq WHERE activa = true`);
  const faqList = faqs.rows.map((f, i) => `${i+1}. FAQ: "${f.pregunta}" | Intención: "${f.keywords}"`).join('\n');
  
  // Construye ejemplos de FAQ si existen
  let faqExamples = {};
  try {
    const exRows = await pool.query('SELECT faq_id, comment_text FROM faq_examples ORDER BY created_at DESC LIMIT 50');
    for (const ex of exRows.rows) {
      if (!faqExamples[ex.faq_id]) faqExamples[ex.faq_id] = [];
      faqExamples[ex.faq_id].push(ex.comment_text);
    }
  } catch(e) {}

  const prompt = `Sos un clasificador para el canal de YouTube/Facebook de Javi, un joyero argentino.

Analizá este comentario y decidí a qué categoría pertenece. Respondé SOLO el nombre de la categoría o "ignorar".

CATEGORÍAS:
- elogio: felicitaciones, apoyo, "me encanta", "sos un crack", saludos desde otro país. NO es elogio si contiene insultos o críticas disfrazadas${catMap.elogio?.exclusiones?.length > 0 ? '. EXCLUIR si contiene: ' + catMap.elogio.exclusiones.join(', ') : ''}
- gracioso: chiste, ironía, referencia a serie/película, comentario cómico, humor${catMap.gracioso?.exclusiones?.length > 0 ? '. EXCLUIR si contiene: ' + catMap.gracioso.exclusiones.join(', ') : ''}
- residuos: preguntan específicamente qué hace Javi con sus residuos químicos, si contamina con sus procesos, si tira el ácido al desagüe${catMap.residuos?.exclusiones?.length > 0 ? '. EXCLUIR si contiene: ' + catMap.residuos.exclusiones.join(', ') : ''}
- no_metal: preguntan si Javi vende plata, oro, metal, granalla, chapa en bruto${catMap.no_metal?.exclusiones?.length > 0 ? '. EXCLUIR si contiene: ' + catMap.no_metal.exclusiones.join(', ') : ''}
- compra_joya: preguntan cómo comprarle una joya, precio de una pieza, dónde comprar${catMap.compra_joya?.exclusiones?.length > 0 ? '. EXCLUIR si contiene: ' + catMap.compra_joya.exclusiones.join(', ') : ''}
- oro_electronica: preguntan si refina o extrae oro de placas electrónicas, chatarra electrónica${catMap.oro_electronica?.exclusiones?.length > 0 ? '. EXCLUIR si contiene: ' + catMap.oro_electronica.exclusiones.join(', ') : ''}
${faqList.length > 0 ? faqs.rows.map((f, i) => `- faq_${f.id}: ${f.pregunta}${faqExamples[f.id]?.length > 0 ? ' (ej: "' + faqExamples[f.id].slice(0,2).join('", "') + '")' : ''}`).join('\n') : ''}
- ignorar: cualquier otra cosa

COMENTARIO: "${text.substring(0, 300)}"

Respondé SOLO una palabra: el nombre exacto de la categoría o "ignorar".`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 20,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    const answer = (data.content?.[0]?.text || '').trim().toLowerCase().split(/\s/)[0];
    console.log('[agent] haiku categoria:', answer, '| comment:', text.substring(0, 50));
    return answer;
  } catch(e) {
    console.error('[agent] haiku error:', e.message);
    return 'ignorar';
  }
}

// ─── PROCESAR COMENTARIO ──────────────────────────────────────────────────────

async function procesarComentario(comment) {
  const text = comment.text || '';

  // Texto vacío = emoji que FB no transmite
  if (!text || text.trim() === '') {
    const emojis = ['🙌', '💪', '🔥', '😄', '👍', '🫡'];
    return { categoria: 'emoji', respuesta: emojis[Math.floor(Math.random() * emojis.length)] };
  }

  // 1. Detección hardcodeada (rápida, sin IA)
  const hardcode = detectarHardcode(text);
  if (hardcode === 'emoji') {
    const emojis = ['🙌', '💪', '🔥', '😄', '👍', '🫡'];
    return { categoria: 'emoji', respuesta: emojis[Math.floor(Math.random() * emojis.length)] };
  }
  if (hardcode === 'yeti') return { categoria: 'yeti', respuesta: getRespuestaDB('yeti') || getRespuesta('yeti') };
  if (hardcode === 'sudaca') return { categoria: 'sudaca', respuesta: getRespuestaDB('sudaca') || getRespuesta('sudaca') };
  if (hardcode === 'curso') return { categoria: 'curso', respuesta: getRespuestaDB('curso') || getRespuesta('curso') };

  // 2. Haiku decide para el resto
  const categoria = await detectarConHaiku(text, {});

  if (categoria === 'ignorar' || !categoria) return null;

  // FAQ match
  if (categoria.startsWith('faq_')) {
    const faqId = parseInt(categoria.split('_')[1]);
    const faqRow = await pool.query('SELECT * FROM faq WHERE id = $1 AND activa = true', [faqId]);
    if (faqRow.rows.length > 0) {
      const faq = faqRow.rows[0];
      const respuesta = faq.respuestas[Math.floor(Math.random() * faq.respuestas.length)];
      return { categoria: 'faq', respuesta };
    }
    return null;
  }

  // Categorías con Haiku
  const cats = ['elogio', 'gracioso', 'residuos', 'no_metal', 'compra_joya', 'oro_electronica'];
  if (cats.includes(categoria)) {
    const respuesta = await getRespuestaDB(categoria) || getRespuesta(categoria);
    if (respuesta) return { categoria, respuesta };
  }

  return null;
}

async function getRespuestaDB(nombre) {
  try {
    const row = await pool.query('SELECT respuestas FROM agent_categories WHERE nombre = $1 AND activa = true', [nombre]);
    if (row.rows.length > 0 && row.rows[0].respuestas.length > 0) {
      const lista = row.rows[0].respuestas;
      return lista[Math.floor(Math.random() * lista.length)];
    }
  } catch(e) {}
  return null;
}

// ─── POSTEAR EN FB ────────────────────────────────────────────────────────────

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

async function saveAsAnswered(id, commentText, replyText, videoTitle, postUrl) {
  try { await pool.query(`ALTER TABLE comment_state ADD COLUMN IF NOT EXISTS post_url TEXT`); } catch(e) {}
  await pool.query(`
    INSERT INTO comment_state (id, status, comment_text, reply_text, video_title, source, post_url)
    VALUES ($1, 'answered', $2, $3, $4, 'ai', $5)
    ON CONFLICT (id) DO UPDATE SET status='answered', reply_text=$3, video_title=$4, source='ai', post_url=$5
  `, [id, commentText || '', replyText || '', videoTitle || '', postUrl || '']);
}

// ─── CICLO PRINCIPAL ──────────────────────────────────────────────────────────

async function runAgent(network = 'fb') {
  console.log(`[agent] ▶ INICIO ciclo ${network} - ${new Date().toISOString()}`);

  const runResult = await pool.query(`INSERT INTO agent_runs (network) VALUES ($1) RETURNING id`, [network]);
  const runId = runResult.rows[0].id;

  let fetched = 0, replied = 0, ignored = 0;

  try {
    // Traer comentarios via endpoint interno
    const state = await pool.query(`SELECT id, status FROM comment_state WHERE created_at > NOW() - INTERVAL '60 days'`);
    const answeredIds = new Set(state.rows.filter(r => r.status === 'answered').map(r => r.id));
    const discardedIds = new Set(state.rows.filter(r => r.status === 'discarded').map(r => r.id));

    const r = await fetch(`http://localhost:${PORT}/fb/comments`);
    if (!r.ok) throw new Error('Error fetching fb/comments: ' + r.status);
    const data = await r.json();
    const allComments = data.comments || [];

    const comments = allComments.filter(c =>
      !answeredIds.has(c.id) && !discardedIds.has(c.id)
    ).map(c => ({
      id: c.id,
      postId: c.postId || c.id,
      postMessage: c.postMessage || '',
      postUrl: c.postUrl || '',
      text: c.text || c.message || '',
      author: c.author || 'Usuario',
      network: 'fb'
    })).slice(0, 50);

    fetched = comments.length;
    console.log(`[agent] comentarios nuevos: ${fetched}`);

    for (const comment of comments) {
      const result = await procesarComentario(comment);

      if (!result) {
        ignored++;
        console.log(`[agent] ignorado: "${comment.text.substring(0, 50)}"`);
        // Marcar como visto para no reprocesar
        await pool.query(`
          INSERT INTO comment_state (id, status, comment_text, video_title, source)
          VALUES ($1, 'discarded', $2, $3, 'ai_ignored')
          ON CONFLICT (id) DO NOTHING
        `, [comment.id, comment.text || '', comment.postMessage || '']);
        continue;
      }

      try {
        await postFBReply(comment.id, result.respuesta);
        await saveAsAnswered(comment.id, comment.text, result.respuesta, comment.postMessage, comment.postUrl);
        replied++;
        console.log(`[agent] ✅ ${result.categoria}: "${comment.text.substring(0, 40)}" → "${result.respuesta}"`);
      } catch(e) {
        console.error('[agent] error posteando:', e.message);
        ignored++;
      }

      await new Promise(r => setTimeout(r, 600));
    }

    const msg = `🤖 <b>Agente - ciclo completado</b>\n📥 Procesados: <b>${fetched}</b>\n✅ Respondidos: <b>${replied}</b>\n⏭️ Ignorados: <b>${ignored}</b>`;
    await sendTelegram(msg);

    await pool.query(`UPDATE agent_runs SET finished_at=NOW(), comments_fetched=$2, comments_auto_replied=$3, comments_ignored=$4 WHERE id=$1`,
      [runId, fetched, replied, ignored]);

    console.log(`[agent] ▶ FIN - respondidos:${replied} ignorados:${ignored}`);
    return { fetched, replied, ignored };

  } catch(e) {
    console.error('[agent] ERROR:', e.message);
    await pool.query(`UPDATE agent_runs SET finished_at=NOW(), error=$2 WHERE id=$1`, [runId, e.message]);
    await sendTelegram(`❌ <b>Error en agente</b>\n${e.message}`);
    throw e;
  }
}

// ─── STATS ────────────────────────────────────────────────────────────────────

async function getAgentStats() {
  const runs = await pool.query(`SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 10`);
  const pending = await pool.query(`SELECT COUNT(*) as cnt FROM agent_runs`);
  const totalReplied = await pool.query(`SELECT COALESCE(SUM(comments_auto_replied), 0) as total FROM agent_runs`);

  return {
    recent_runs: runs.rows,
    total_auto_replied: parseInt(totalReplied.rows[0].total),
    pending_review: 0
  };
}

async function getCategories() {
  const rows = await pool.query(`SELECT * FROM agent_categories ORDER BY nombre`);
  return rows.rows;
}

module.exports = {
  initAgentDB,
  runAgent,
  getAgentStats,
  getCategories,
  sendTelegram
};
