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
      source TEXT DEFAULT 'historico',
      approved_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migración: agregar columna source si no existe
  const srcCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='reply_examples' AND column_name='source'
  `);
  if (srcCheck.rows.length === 0) {
    await pool.query(`ALTER TABLE reply_examples ADD COLUMN source TEXT DEFAULT 'historico'`);
    console.log('[agent] columna source agregada a reply_examples');
  }

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
  // ── PRIORIDAD 1: ejemplos aprobados manualmente en el agente ─────────────────
  // Primero del mismo post, luego generales — estos son los más confiables
  const agentPostExamples = await pool.query(`
    SELECT comment_text, reply_text, post_title FROM reply_examples
    WHERE post_id = $1 AND source = 'agente'
    ORDER BY approved_at DESC LIMIT 8
  `, [postId]);

  const agentGeneralExamples = await pool.query(`
    SELECT comment_text, reply_text, post_title FROM reply_examples
    WHERE source = 'agente'
    ORDER BY approved_at DESC LIMIT $1
  `, [limit]);

  const agentExamples = [...agentPostExamples.rows, ...agentGeneralExamples.rows];

  // ── PRIORIDAD 2: historial viejo (comment_state migrado) ──────────────────────
  // Solo se usa si el agente tiene menos de 10 ejemplos propios
  let fallbackExamples = [];
  if (agentExamples.length < 10) {
    const needed = limit - agentExamples.length;
    const fallback = await pool.query(`
      SELECT comment_text, reply_text, post_title FROM reply_examples
      WHERE source != 'agente' OR source IS NULL
      ORDER BY RANDOM() LIMIT $1
    `, [needed]);
    fallbackExamples = fallback.rows;
    if (fallbackExamples.length > 0) {
      console.log(`[agent] usando ${agentExamples.length} ejemplos agente + ${fallbackExamples.length} fallback histórico`);
    }
  }

  const all = [...agentExamples, ...fallbackExamples];

  // Deduplicar
  const seen = new Set();
  return all.filter(e => {
    if (seen.has(e.comment_text)) return false;
    seen.add(e.comment_text);
    return true;
  }).slice(0, limit);
}

// ─── SELECCIÓN DE MODELO ──────────────────────────────────────────────────────
// Haiku para el 90% (barato) — Sonnet solo para casos técnicos o complejos

function selectModel(comment, postContext) {
  const text = comment.toLowerCase();
  const needsSonnet =
    comment.length > 150 ||
    (text.split('?').length - 1) >= 2 ||
    /como|por que|cuanto|temperatura|acido|acido|proceso|refinad|pureza|aleacion|quilate|karat|formula|electro|voltaje|densidad|fundicion/.test(text) ||
    (postContext && postContext.content_type === 'proceso_quimico' && text.includes('?'));
  const model = needsSonnet ? 'claude-sonnet-4-20250514' : 'claude-haiku-4-5';
  console.log('[agent] modelo:', model, '| chars:', comment.length);
  return model;
}


// ─── BUSCAR FAQ MATCH ─────────────────────────────────────────────────────────

async function checkFAQ(comment) {
  try {
    const faqs = await pool.query('SELECT * FROM faq WHERE activa = true');
    if (faqs.rows.length === 0) return null;

    // Traer ejemplos de matching aprobados por Javi para cada FAQ
    let faqExamples = {};
    try {
      const exRows = await pool.query('SELECT faq_id, comment_text FROM faq_examples ORDER BY created_at DESC LIMIT 50');
      for (const ex of exRows.rows) {
        if (!faqExamples[ex.faq_id]) faqExamples[ex.faq_id] = [];
        faqExamples[ex.faq_id].push(ex.comment_text);
      }
    } catch(e) {} // tabla puede no existir aún

    // Construir lista de todas las FAQs en una sola llamada — más eficiente y más contexto
    const faqList = faqs.rows.map((f, i) => {
      const examples = faqExamples[f.id] || [];
      const exBlock = examples.length > 0 ? ' | Ejemplos reales: ' + examples.slice(0,3).map(e => '"'+e+'"').join(', ') : '';
      return `${i+1}. Pregunta: "${f.pregunta}" | Intención: "${f.keywords}"${exBlock}`;
    }).join('\n');
    
    const matchPrompt = `Sos un clasificador de comentarios para el canal de YouTube/Facebook de Javi, un joyero argentino.

Tu tarea: determinar si el comentario siguiente corresponde a alguna de estas preguntas frecuentes del canal.

PREGUNTAS FRECUENTES:
${faqList}

COMENTARIO: "${comment.substring(0, 300)}"

REGLAS IMPORTANTES:
- Analizá la INTENCIÓN del comentario, no solo las palabras exactas
- Un comentario corto o vago puede igualmente corresponder a una FAQ si el tema coincide
- Considerá el contexto: es un canal de joyería que trabaja con ácidos, metales y procesos químicos
- Si el comentario toca el tema de una FAQ aunque sea de forma indirecta, contá como match

Si corresponde a alguna FAQ, respondé SOLO el número (ej: "1" o "2"). Si no corresponde a ninguna, respondé SOLO "no".`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 5,
        messages: [{ role: 'user', content: matchPrompt }]
      })
    });
    const data = await r.json();
    const answer = (data.content?.[0]?.text || '').trim().toLowerCase();
    
    if (answer === 'no' || answer === '') return null;
    
    const idx = parseInt(answer) - 1;
    if (!isNaN(idx) && faqs.rows[idx]) {
      const faq = faqs.rows[idx];
      const respuesta = faq.respuestas[Math.floor(Math.random() * faq.respuestas.length)];
      console.log('[agent] FAQ match "' + faq.pregunta.substring(0, 40) + '" para: "' + comment.substring(0, 40) + '"');
      return respuesta;
    }
    return null;
  } catch(e) {
    console.error('[agent] checkFAQ error:', e.message);
    return null;
  }
}

// ─── GENERADOR DE RESPUESTA ─────────────────────────────────────────────────
// Usa exactamente el mismo prompt y lógica que /suggest-reply — el que ya funcionaba bien

async function generateReply(comment, postContext, examples) {
  // Construir bloque de ejemplos con los aprobados por Javi (prioridad agente, luego histórico)
  let ejemplosBloque = '';
  if (examples.length > 0) {
    ejemplosBloque = '\n\nAPRENDÉ EL TONO de estos ejemplos reales de Javi. No copies ninguno igual — usalos como guía de estilo:\n';
    examples.forEach((ex, i) => {
      ejemplosBloque += '\nEjemplo ' + (i+1) + ':' + (ex.post_title ? '\n(Post: ' + ex.post_title + ')' : '') + '\nComentario: "' + ex.comment_text + '"\nRespuesta: "' + ex.reply_text + '"\n';
    });
  }

  const prompt = 'Sos Javi (Javier Romero), joyero argentino del canal Joyeria Sudaca. Tu tono es casual, directo, rioplatense natural — sin exagerar el acento, sin sonar a robot.' + ejemplosBloque + `

CATEGORÍAS Y VARIACIONES — elegí UNA al azar de la categoría que corresponda:

Elogios o felicitaciones:
- "muchas gracias me alegro que te guste mi contenido"
- "gracias por el aguante, me pone muy feliz que te guste"
- "muchas gracias bro, un abrazo grande 🙌"
- "gracias de verdad, me pone muy feliz que me digas esto 😄"
- "increíble lo que me decís, muchas gracias por el aguante!!! 💪"

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
- "claro que sí 💪"

Cuestionan que no explico bien el proceso o piden más detalle:
- "este video no es un tutorial ni un curso, es una forma de hacer que más gente conozca el oficio"
- "un video de 30 segundos nunca jamás puede enseñar algo"
- "son videos entretenidos para que más gente conozca el oficio, no se puede hacer un curso en 30 segundos"

Quieren empezar en joyería / piden consejos:
- "si te lo proponés lo podés lograr, metele para adelante 💪"
- "se empieza por el principio, metele y ya vas a lograr hacer tus primeras piezas"
- "metele, si te gusta el oficio siempre se puede aprender 🙌"

Elogian mi forma de narrar / el speech:
- "muchas gracias mi hermano, me pone contento que te guste la forma que tengo de explicar"
- "jaja me alegro bro, muchas gracias 😄"
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
- "Es rentable?" → "Si tiene plata pero no es muy rentable de extraer"
- "Por qué no fundís directo?" → "Si solo fundimos no podemos garantizar la pureza del metal"
- Pepetools → "Está en mi bio, cupón vanallen 10% de descuento"
- Saludo desde otro país → variación de "me alegro que te guste el contenido, abrazo grande"
- IDIOMA: detectá el idioma del comentario y respondé EN ESE MISMO IDIOMA. Si no es español, usá respuestas genéricas y cortas.

INSTRUCCIÓN: UNA SOLA respuesta lista para publicar, sin comillas ni explicaciones.
Comentario: ${comment}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: selectModel(comment, postContext),
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    const text = data.content?.[0]?.text?.trim() || null;
    if (!text) return null;

    // Validar que no sea texto del prompt filtrado
    const invalidPhrases = [
      'esperando el comentario',
      'espero el comentario',
      'espero que me proporciones',
      'comentario a responder',
      'instrucción:',
      'instruccion:',
      'categorías y variaciones',
      'como javi',
      'respondé como',
      'responder como javi',
      'sos javi',
      'soy javi romero',
      'listo para responder',
      'una vez que lo hagas',
      'cuando envíes',
      'cuando me envíes',
      'proporciones el comentario',
      'en personaje',
      'estoy en personaje',
      'joyería sudaca.',
    ];
    const textLower = text.toLowerCase();
    if (invalidPhrases.some(p => textLower.includes(p))) {
      console.error('[agent] respuesta inválida descartada:', text.substring(0, 80));
      return null;
    }

    // Validar longitud mínima y máxima
    if (text.length < 3 || text.length > 500) return null;

    return text;
  } catch (e) {
    console.error('[agent] generateReply error:', e.message);
    return null;
  }
}


// ─── CALCULAR CONFIANZA ───────────────────────────────────────────────────────

async function calculateConfidence(comment, postId) {
  const text = comment.toLowerCase();

  // REGLAS DURAS — confianza fija, no necesitan cálculo

  // Solo emojis
  const soloEmojis = comment.trim().replace(/[🀀-🿿☀-⟿︀-﻿🤀-🧿🨀-🫿 -  -⁯✀-➿ ]/gu, '');
  if (soloEmojis.length === 0 && comment.trim().length > 0) {
    console.log('[agent] confianza: 0.95 (solo emojis)');
    return 0.95;
  }

  // Elogios claros
  const esElogio = [
    /yeti|h.brido/i,
    /sudaca/i,
    /genial|excelente|incre.ble|buen.simo|espectacular|crack|capo|groso|grosso/i,
    /muy buen|buen video|buen contenido|gran video|gran trabajo/i,
    /me encanta|me gust/i,
    /sos el mejor|sos un genio|sos un capo|sos un crack/i,
    /qué bueno|que bueno|qué lindo|que lindo/i,
    /de donde sos|de d.nde sos|argentina/i,
    /suscrib/i,
    /felicit|bravo|brillante|top/i
  ].some(p => p.test(text));

  if (esElogio && comment.length < 150) {
    console.log('[agent] confianza: 0.90 (elogio detectado)');
    return 0.90;
  }

  // Emojis positivos con texto corto
  if (/[🔥💪👏❤😍🙌👍⭐🏆]/.test(comment) && comment.length < 60) {
    console.log('[agent] confianza: 0.82 (emoji positivo corto)');
    return 0.82;
  }

  // CÁLCULO NORMAL para el resto
  const postExamples = await pool.query(
    'SELECT COUNT(*) as cnt FROM reply_examples WHERE post_id = $1', [postId]
  );
  const postExampleCount = parseInt(postExamples.rows[0].cnt);
  const totalExamples = await pool.query('SELECT COUNT(*) as cnt FROM reply_examples');
  const total = parseInt(totalExamples.rows[0].cnt);

  let confidence = total >= 100 ? 0.50 : total >= 10 ? 0.40 : 0.25;
  if (postExampleCount > 0) confidence += 0.15;
  if (postExampleCount > 5) confidence += 0.10;
  if (comment.length > 200) confidence -= 0.15;
  if ((comment.match(/\?/g) || []).length >= 2) confidence -= 0.20;

  console.log('[agent] confianza: ' + confidence.toFixed(2) + ' | total: ' + total + ' | post: ' + postExampleCount);
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

async function saveAsAnswered(id, commentText, replyText, videoTitle, postUrl) {
  try { await pool.query(`ALTER TABLE comment_state ADD COLUMN IF NOT EXISTS post_url TEXT`); } catch(e) {}
  await pool.query(`
    INSERT INTO comment_state (id, status, comment_text, reply_text, video_title, source, post_url)
    VALUES ($1, 'answered', $2, $3, $4, 'ai', $5)
    ON CONFLICT (id) DO UPDATE SET status='answered', reply_text=$3, video_title=$4, source='ai', post_url=$5
  `, [id, commentText || '', replyText || '', videoTitle || '', postUrl || '']);
}

// ─── FILTRO DE RESIDUOS QUÍMICOS — RESPUESTA FIJA ────────────────────────────
// Nunca pasa por el modelo. Responde siempre con texto exacto aprobado por Javi.

const WASTE_RESPONSES = [
  'claro que no lo tiro al inodoro, por favor! El ácido se neutraliza y se almacena para luego ser entregado a una empresa que se encarga de su neutralización final 💪',
  'jamás al desagüe! Se neutraliza y va a disposición final con empresa especializada 🙌',
  'eso nunca, se neutraliza con bicarbonato y se entrega a empresa de disposición final 👋'
];

function isWasteQuestion(comment) {
  const text = comment.toLowerCase();
  // Debe mencionar residuos/descarte Y contexto químico
  const residuoPatterns = [
    /tir(á|a|as|o)\s*(el\s*)?(ácido|acido|líquido|liquido|residuo|desecho)/,
    /qué\s*hac(é|e)s?\s*(con\s*)?(el\s*)?(ácido|acido|residuo|desecho|líquido)/,
    /cómo\s*(descart|eliminá|tir)/,
    /inodoro|cañería|caneria|desagüe|desague|alcantarilla/,
    /residuo|desecho|descarte|neutraliza/,
    /contamina|medio\s*ambiente|ecolog/
  ];
  const acidContext = /ácido|acido|químico|quimico|nitrico|sulfúrico|sulfurico|solución|solucion/.test(text);
  return residuoPatterns.some(p => p.test(text)) && (acidContext || /residuo|desecho|neutraliza/.test(text));
}

// ─── FILTRO DE SEGURIDAD QUÍMICA ─────────────────────────────────────────────
// Comentarios con contenido químico/peligroso van SIEMPRE a cola, nunca auto-responden
// Es un filtro de código — no depende del modelo

function isChemicalRisk(comment) {
  const text = comment.toLowerCase();
  const patterns = [
    // Ácidos y químicos
    /ácido|acido|nitrico|sulfúrico|sulfurico|clorhídrico|clorhidrico|fluorhídrico|fluorhidrico/,
    /agua regia|aqua regia|cianuro|cianur/,
    /hidróxido|hidroxido|soda caustica|soda cáustica|lejía|lejia/,
    /peróxido|peroxido|h2o2|hno3|h2so4|hcl/,
    // Procesos peligrosos
    /fundir|fundición|fundicion|derretir|derretí/,
    /temperatura|grados|celsius|fahrenheit|°c|°f/,
    /mezcl|combina|disuelv|diluí|dilui/,
    /electrolisis|electrólisis|electrolit/,
    /cloro|amoniaco|amoníaco/,
    // Metales y procesos de refinado
    /refinar|refinado|purificar|pureza|quilate|karat/,
    /mercurio|plomo|arsénico|arsenico|cadmio/,
    /soldar|soldadura|flux|borax|bórax/,
    /decapar|decapado|mordiente/,
    // Vapores y gases
    /vapor|gas|humo|ventilación|ventilacion|respirar|inhalar/,
    /tóxico|toxico|veneno|peligro|quemadura/
  ];
  return patterns.some(p => p.test(text));
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
    // Solo traer IDs respondidos/descartados en los últimos 60 días para no bloquear todo
    const state = await pool.query(`
      SELECT id, status FROM comment_state 
      WHERE created_at > NOW() - INTERVAL '60 days'
    `);
    const answeredIds = new Set(state.rows.filter(r => r.status === 'answered').map(r => r.id));
    const discardedIds = new Set(state.rows.filter(r => r.status === 'discarded').map(r => r.id));

    // También chequear review_queue para no procesar dos veces
    const inQueue = await pool.query(`SELECT id FROM review_queue WHERE status = 'pending'`);
    const queuedIds = new Set(inQueue.rows.map(r => r.id));
    
    console.log('[agent] filtros cargados — answered:', answeredIds.size, '| discarded:', discardedIds.size, '| inQueue:', queuedIds.size);

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

        // Skipear comentarios vacíos o sin sentido
        if (!comment.text || comment.text.trim().length < 2) {
          skipped++;
          processed.add(comment.id);
          console.log('[agent] skipped (muy corto):', JSON.stringify(comment.text));
          continue;
        }

        // Buscar ejemplos aprendidos
        const examples = await getLearnedExamples(postId, comment.text);

        // Filtro de seguridad química — va siempre a cola, nunca auto-responde
        const chemRisk = isChemicalRisk(comment.text);
        if (chemRisk) {
          console.log(`[agent] ⚠️ riesgo químico detectado, mandando a cola: "${comment.text.substring(0, 50)}"`);
        }

        // Filtro de residuos — respuesta fija, nunca pasa por el modelo
        if (isWasteQuestion(comment.text)) {
          const wasteReply = WASTE_RESPONSES[Math.floor(Math.random() * WASTE_RESPONSES.length)];
          try {
            await postFBReply(comment.id, wasteReply);
            await saveAsAnswered(comment.id, comment.text, wasteReply, comment.postMessage || postContext.title || '', comment.postUrl);
            autoReplied++;
            console.log('[agent] ✅ residuos (respuesta fija): "' + comment.text.substring(0, 50) + '"');
          } catch(e) {
            await addToQueue(comment, postContext, wasteReply, 0.99, 'residuos_fijo');
            queued++;
          }
          processed.add(comment.id);
          await new Promise(r => setTimeout(r, 500));
          continue;
        }

        // Chequear FAQ primero — respuesta canónica si hay match
        const faqReply = await checkFAQ(comment.text);
        if (faqReply && !chemRisk) {
          try {
            await postFBReply(comment.id, faqReply);
            await saveAsAnswered(comment.id, comment.text, faqReply, comment.postMessage || postContext.title || '', comment.postUrl);
            autoReplied++;
            console.log('[agent] ✅ FAQ auto-respondido: "' + comment.text.substring(0, 50) + '"');
          } catch(e) {
            await addToQueue(comment, postContext, faqReply, 0.95, 'faq_match');
            queued++;
          }
          processed.add(comment.id);
          await new Promise(r => setTimeout(r, 500));
          continue;
        }

        // Calcular confianza
        const confidence = chemRisk ? 0 : await calculateConfidence(comment.text, postId);

        // Generar respuesta
        const reply = await generateReply(comment.text, postContext, examples);

        if (!reply) {
          // Fallback: respuesta genérica para comentarios que el modelo no supo procesar
          const fallbackReply = 'perdón, no entiendo bien la pregunta 🤷';
          await addToQueue(comment, postContext, fallbackReply, 0.1, 'modelo_no_respondio');
          queued++;
          processed.add(comment.id);
          continue;
        }

        if (confidence >= 0.55 && !chemRisk) {
          // ── AUTO-RESPONDER ──────────────────────────────────────────────────
          try {
            await postFBReply(comment.id, reply);
            await saveAsAnswered(comment.id, comment.text, reply, comment.postMessage || postContext.title || '', comment.postUrl);
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
          await addToQueue(comment, postContext, reply, confidence, chemRisk ? 'quimica_siempre_manual' : 'baja_confianza');
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
  console.log('[agent/fetchFB] usando endpoint interno /fb/comments');
  try {
    // Usar el mismo endpoint que ya funciona en la app — rápido y confiable
    const BACKEND_URL = `http://localhost:${process.env.PORT || 8080}`;
    const r = await fetch(`${BACKEND_URL}/fb/comments`);
    if (!r.ok) {
      console.error('[agent/fetchFB] error endpoint:', r.status);
      return [];
    }
    const data = await r.json();
    const allComments = data.comments || [];
    
    // Filtrar los que ya procesamos
    const filtered = allComments.filter(c => 
      !answeredIds.has(c.id) && 
      !discardedIds.has(c.id) && 
      !queuedIds.has(c.id)
    ).map(c => ({
      id: c.id,
      postId: c.postId || c.id,
      postMessage: c.postMessage || '',
      postUrl: c.postUrl || '',
      text: c.text || c.message || '',
      author: c.author || c.authorName || 'Usuario',
      publishedAt: c.publishedAt || c.created_time,
      network: 'fb'
    }));

    console.log('[agent/fetchFB] total sin filtrar:', allComments.length, '| nuevos:', filtered.length);
    return filtered.slice(0, 50);
  } catch(e) {
    console.error('[agent/fetchFB] error:', e.message);
    return [];
  }
}


async function fetchAllPostComments(postId) {
  // Traer comentarios sin respuesta — filter=stream trae todos, luego filtramos los que no tienen reply de la página
  // Usamos filter=toplevel para evitar subcomentarios y order=reverse_chronological para los más nuevos primero
  const url = `https://graph.facebook.com/v19.0/${postId}/comments?fields=id,message,from,created_time,comments{id,from,message}&limit=100&order=reverse_chronological&filter=stream&access_token=${FB_TOKEN}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || !data.data) return [];
  return data.data;
}

// ─── COLA DE REVISIÓN ─────────────────────────────────────────────────────────

async function addToQueue(comment, postContext, suggestedReply, confidence, reason) {
  // Ensure post_url column exists
  try {
    await pool.query(`ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS post_url TEXT`);
  } catch(e) {}
  await pool.query(`
    INSERT INTO review_queue (id, comment_text, post_id, post_title, author, network, suggested_reply, confidence, reason, post_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO NOTHING
  `, [
    comment.id,
    comment.text,
    comment.postId,
    comment.postMessage || postContext?.title || '',
    comment.author,
    comment.network || 'fb',
    suggestedReply,
    confidence,
    reason,
    comment.postUrl || ''
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
    INSERT INTO reply_examples (comment_text, reply_text, post_id, post_title, network, source)
    VALUES ($1, $2, $3, $4, $5, 'agente')
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
