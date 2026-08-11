/* ═══════════════════════════════════════════════════════════════
   rec-whisper.js
   Plays the recording disclosure to the SELLER before the two legs
   bridge. Twilio hits this via the url="" attribute on <Number>.

   Why a whisper and not a <Say> before <Dial>: in this app Twilio
   rings the AGENT first, so anything before <Dial> is heard only by
   the agent. The seller needs to hear it, so it goes here.

   Mirrors VM Drop: AI voice by default, recorded audio if set.
   ═══════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');

const DEFAULT_TEXT =
  'Just so you know, this call may be recorded for quality purposes.';

function xml(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
  };
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

exports.handler = async () => {
  let cfg = {};
  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data } = await sb
      .from('recording_config')
      .select('*')
      .eq('id', 1)
      .single();
    cfg = data || {};
  } catch (e) {
    // Config unreachable — still play the default. Never connect a
    // recorded call silently just because the database hiccuped.
  }

  if (cfg.enabled === false) return xml('');

  if (cfg.disclosure_mode === 'audio' && cfg.disclosure_audio_url) {
    return xml(`<Play>${esc(cfg.disclosure_audio_url)}</Play>`);
  }

  const voice = cfg.voice || 'Polly.Ruth-Generative';
  const text  = cfg.disclosure_text || DEFAULT_TEXT;
  return xml(`<Say voice="${esc(voice)}">${esc(text)}</Say>`);
};
