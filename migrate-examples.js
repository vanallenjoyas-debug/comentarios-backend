// MIGRACIÓN ÚNICA — corre una sola vez
// Copia respuestas aprobadas de comment_state → reply_examples
// Así el agente arranca con todo el historial que ya existe

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.PG_URL });

async function migrate() {
  console.log('▶ Iniciando migración...');

  // Traer todas las respuestas aprobadas con texto real
  const source = await pool.query(`
    SELECT id, comment_text, reply_text, video_title, categoria, source
    FROM comment_state
    WHERE status = 'answered'
      AND comment_text IS NOT NULL AND comment_text != ''
      AND reply_text IS NOT NULL AND reply_text != ''
      AND LENGTH(comment_text) > 2
      AND LENGTH(reply_text) > 2
    ORDER BY created_at ASC
  `);

  console.log(`📦 Encontradas ${source.rows.length} respuestas en comment_state`);

  let inserted = 0, skipped = 0;

  for (const row of source.rows) {
    try {
      // Verificar que no exista ya en reply_examples
      const exists = await pool.query(
        `SELECT id FROM reply_examples WHERE comment_text = $1 AND reply_text = $2 LIMIT 1`,
        [row.comment_text, row.reply_text]
      );
      if (exists.rows.length > 0) { skipped++; continue; }

      await pool.query(`
        INSERT INTO reply_examples (comment_text, reply_text, post_title, categoria, network, source, approved_at)
        VALUES ($1, $2, $3, $4, $5, 'historico', NOW())
      `, [
        row.comment_text,
        row.reply_text,
        row.video_title || '',
        row.categoria || 'otro',
        'yt'
      ]);
      inserted++;

      if (inserted % 100 === 0) console.log(`  ... ${inserted} migrados`);
    } catch (e) {
      console.error('Error en fila:', e.message);
    }
  }

  const total = await pool.query(`SELECT COUNT(*) as cnt FROM reply_examples`);
  console.log(`\n✅ Migración completa`);
  console.log(`   Insertados: ${inserted}`);
  console.log(`   Ya existían: ${skipped}`);
  console.log(`   Total en reply_examples: ${total.rows[0].cnt}`);

  await pool.end();
}

migrate().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
