/* ═══════════════════════════════════════════════════════════════
   recording-status.js
   Twilio posts here when a recording starts, finishes, or fails.

   On 'completed' it copies the mp3 into Supabase Storage and then
   deletes it from Twilio, so there's exactly one copy and one clock
   to reason about for the 30-day purge. If the copy fails, the row
   stays 'pending' and the Twilio recording survives — nothing is
   ever lost silently.
   ═══════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'call-recordings';

function sb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const p = new URLSearchParams(event.body || '');
  const callSid  = p.get('CallSid');
  const recSid   = p.get('RecordingSid');
  const recUrl   = p.get('RecordingUrl');
  const status   = p.get('RecordingStatus');   // in-progress | completed | absent
  const duration = parseInt(p.get('RecordingDuration') || '0', 10);

  if (!callSid) return { statusCode: 200, body: 'no call sid' };

  const db = sb();

  // Not finished yet — just stamp the SID so the pause/resume
  // controls in the drawer have something to act on.
  if (status !== 'completed') {
    await db.from('calls')
      .update({
        recording_sid: recSid || null,
        recording_status: status === 'absent' ? 'absent' : 'pending',
      })
      .eq('twilio_sid', callSid);
    return { statusCode: 200, body: 'ok' };
  }

  try {
    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    const res = await fetch(`${recUrl}.mp3`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new Error('Twilio media fetch failed: ' + res.status);

    const buf  = Buffer.from(await res.arrayBuffer());
    const day  = new Date().toISOString().slice(0, 10);
    const path = `${day}/${recSid}.mp3`;

    const up = await db.storage.from(BUCKET).upload(path, buf, {
      contentType: 'audio/mpeg',
      upsert: true,
    });
    if (up.error) throw up.error;

    await db.from('calls').update({
      recording_sid:      recSid,
      recording_path:     path,
      recording_duration: duration,
      recording_status:   'completed',
    }).eq('twilio_sid', callSid);

    // One copy, one clock. Drop the Twilio original.
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recSid}.json`,
      { method: 'DELETE', headers: { Authorization: `Basic ${auth}` } }
    ).catch(() => {});

    return { statusCode: 200, body: 'stored' };
  } catch (err) {
    // Leave it pending — the Twilio copy is still there to retry from.
    await db.from('calls').update({
      recording_sid:    recSid,
      recording_status: 'pending',
    }).eq('twilio_sid', callSid);
    console.error('recording-status:', err.message);
    return { statusCode: 200, body: 'deferred' };
  }
};
