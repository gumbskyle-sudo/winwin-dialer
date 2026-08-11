/* ═══════════════════════════════════════════════════════════════
   cleanup-recordings.js
   Scheduled daily. Deletes recordings past the retention window
   (30 days by default, set in recording_config.retention_days).

   Wire the schedule in netlify.toml:

     [functions."cleanup-recordings"]
       schedule = "0 7 * * *"

   The call row itself is kept — only the audio and its pointer go.
   Your call log, KPIs, and coaching scores stay intact.
   ═══════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'call-recordings';

exports.handler = async () => {
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: cfg } = await db
    .from('recording_config').select('retention_days').eq('id', 1).single();
  const days = (cfg && cfg.retention_days) || 30;

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const { data: stale, error } = await db
    .from('calls')
    .select('id, recording_path')
    .not('recording_path', 'is', null)
    .lt('started_at', cutoff)
    .limit(500);

  if (error) {
    console.error('cleanup-recordings query:', error.message);
    return { statusCode: 500, body: error.message };
  }
  if (!stale || !stale.length) {
    return { statusCode: 200, body: 'nothing to purge' };
  }

  const paths = stale.map(r => r.recording_path).filter(Boolean);
  const del = await db.storage.from(BUCKET).remove(paths);
  if (del.error) {
    console.error('cleanup-recordings storage:', del.error.message);
    return { statusCode: 500, body: del.error.message };
  }

  await db.from('calls')
    .update({ recording_path: null, recording_status: 'purged' })
    .in('id', stale.map(r => r.id));

  console.log(`Purged ${paths.length} recordings older than ${days} days`);
  return { statusCode: 200, body: `purged ${paths.length}` };
};
