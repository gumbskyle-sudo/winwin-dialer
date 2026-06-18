/* Real Estate Dialer — single backend
 * ─────────────────────────────────────
 * Required env vars (Netlify → Site → Environment variables):
 *   SUPABASE_URL              https://YOUR-PROJECT.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY eyJ...  (server-side only — full DB access)
 *   TWILIO_ACCOUNT_SID        AC...
 *   TWILIO_API_KEY_SID        SK...   (preferred)
 *   TWILIO_API_KEY_SECRET     ...     (preferred)
 *   ACCESS_PASSWORD           a long random string your team shares
 *
 * Fallback if you don't make a Twilio API key:
 *   TWILIO_AUTH_TOKEN
 */

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

// ── Auth & response helpers ───────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Password',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Content-Type': 'application/json',
  };
}
const ok  = (body, code = 200) => ({ statusCode: code, headers: corsHeaders(), body: JSON.stringify(body) });
const err = (msg,  code = 400) => ({ statusCode: code, headers: corsHeaders(), body: JSON.stringify({ error: msg }) });

// ── Twilio helpers ────────────────────────────────────────────
function twilioAuth() {
  const sid    = process.env.TWILIO_API_KEY_SID;
  const secret = process.env.TWILIO_API_KEY_SECRET;
  if (sid && secret) return 'Basic ' + Buffer.from(`${sid}:${secret}`).toString('base64');
  const aSid  = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (aSid && token) return 'Basic ' + Buffer.from(`${aSid}:${token}`).toString('base64');
  throw new Error('Twilio credentials not configured');
}
function twilioSid() {
  const s = process.env.TWILIO_ACCOUNT_SID;
  if (!s) throw new Error('TWILIO_ACCOUNT_SID is required');
  return s;
}
async function tw(path, method = 'GET', formObj) {
  const init = { method, headers: { Authorization: twilioAuth() } };
  if (formObj) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(formObj)) {
      if (v === undefined || v === null) continue;
      body.append(k, String(v));
    }
    init.body = body.toString();
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const r = await fetch(TWILIO_BASE + path, init);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    const e = new Error((json && (json.message || json.error_message)) || `HTTP ${r.status}`);
    e.code = r.status;
    throw e;
  }
  return json;
}
function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
}

// ── Supabase REST helpers (no SDK — keeps function tiny) ──────
function supaUrl() {
  const u = process.env.SUPABASE_URL;
  if (!u) throw new Error('SUPABASE_URL is required');
  return u.replace(/\/+$/, '');
}
function supaKey() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  return k;
}
async function supa(path, method = 'GET', body, extraHeaders) {
  const url = supaUrl() + '/rest/v1' + path;
  const headers = {
    apikey: supaKey(),
    Authorization: 'Bearer ' + supaKey(),
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(extraHeaders || {}),
  };
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) {
    const e = new Error((json && (json.message || json.error)) || `Supabase HTTP ${r.status}`);
    e.code = r.status;
    e.detail = json;
    throw e;
  }
  return { json, count: r.headers.get('content-range') };
}

// ════════════════════════════════════════════════════════════════
// SMS HELPERS
// ════════════════════════════════════════════════════════════════

const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT-OUT'];

function parseFormEncoded(s) {
  const out = {};
  if (!s) return out;
  for (const pair of s.split('&')) {
    const [k, v] = pair.split('=').map(p => decodeURIComponent((p || '').replace(/\+/g, ' ')));
    if (k) out[k] = v || '';
  }
  return out;
}

// Twilio signs every webhook request with HMAC-SHA1. Verify it.
function verifyTwilioSignature(event, formParams) {
  const sig = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'];
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!sig || !authToken) return false; // require auth token specifically for webhook validation
  // Construct the full URL Twilio called
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['host'] || event.headers['Host'];
  const path = event.rawUrl ? new URL(event.rawUrl).pathname + (new URL(event.rawUrl).search || '') : event.path;
  const url = event.rawUrl || (`${proto}://${host}${path}`);
  // Twilio signature recipe: URL + sorted-by-key form params concatenated
  const sortedKeys = Object.keys(formParams).sort();
  let data = url;
  for (const k of sortedKeys) data += k + formParams[k];
  const crypto = require('crypto');
  const computed = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  return computed === sig;
}

async function isOptedOut(e164) {
  try {
    const { json } = await supa(`/sms_opt_outs?e164=eq.${encodeURIComponent(e164)}&select=e164`);
    return Array.isArray(json) && json.length > 0;
  } catch { return false; }
}

async function getAppConfig(key) {
  try {
    const { json } = await supa(`/app_config?key=eq.${encodeURIComponent(key)}&select=value`);
    return Array.isArray(json) && json[0] ? json[0].value : '';
  } catch { return ''; }
}

async function setAppConfig(key, value) {
  // Upsert
  await supa('/app_config?on_conflict=key', 'POST', [{ key, value }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

// Time-zone-friendly send-window check. Default 8 AM – 9 PM US/Eastern.
// (Production would derive from area code; v1 uses one app-wide window.)
function withinSendWindow(now = new Date()) {
  // Convert to America/New_York using Intl
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: 'numeric' });
  const hour = parseInt(fmt.format(now), 10);
  return hour >= 8 && hour < 21;
}

async function sendOneSms(toE164, body, dealId, propertyId, campaignId, stepIndex) {
  // Pre-flight checks
  if (await isOptedOut(toE164)) {
    return { skipped: true, reason: 'opted_out' };
  }
  const fromNumber = await getAppConfig('sms_from_number');
  if (!fromNumber) return { error: 'No SMS sending number configured (Settings → SMS).' };

  // Send via Twilio
  try {
    const j = await tw(`/Accounts/${twilioSid()}/Messages.json`, 'POST', {
      From: fromNumber,
      To: toE164,
      Body: body,
    });
    // Persist
    await supa('/messages', 'POST', [{
      twilio_sid: j.sid,
      deal_id: dealId || null,
      property_id: propertyId || null,
      to_number: toE164,
      from_number: fromNumber,
      direction: 'outbound',
      body,
      status: j.status || 'sent',
      campaign_id: campaignId || null,
      step_index: stepIndex || null,
      sent_at: new Date().toISOString(),
    }], { Prefer: 'return=minimal' });
    return { ok: true, sid: j.sid };
  } catch (e) {
    // Persist failure too so it shows in the conversation
    await supa('/messages', 'POST', [{
      deal_id: dealId || null,
      property_id: propertyId || null,
      to_number: toE164,
      from_number: fromNumber,
      direction: 'outbound',
      body,
      status: 'failed',
      error_message: e.message || String(e),
      campaign_id: campaignId || null,
      step_index: stepIndex || null,
    }], { Prefer: 'return=minimal' });
    return { error: e.message };
  }
}

// ── Drip templates (the 4 we agreed on) ─────────────────────
// Each step has { dayOffset, body } — dayOffset is days from drip start.
// The body uses {first_name}, {address}, {your_name} placeholders.
const DRIP_TEMPLATES = {
  reconsider: {
    label: 'Reconsider',
    steps: [
      { dayOffset: 3,  body: "Hey {first_name}, it's {your_name}. Wanted to circle back on {address} — no pressure, just keeping the door open. My offer's still good if you ever want to revisit. Reply STOP to opt out." },
      { dayOffset: 10, body: "Hey {first_name} — checking in on {address}. The market's moved a bit since we talked. I might have more room than before if you're open to chatting again." },
      { dayOffset: 17, body: "Hey {first_name}, hope you're doing well. Last quick check on {address} — if anything's changed on your end, you've got my number. Either way, take care." },
      { dayOffset: 24, body: "Hey {first_name} — won't keep bugging you. If life ever shifts and selling {address} makes sense, I'm a text away. Wishing you the best." },
    ],
  },
  comp: {
    label: 'Working with Comp',
    steps: [
      { dayOffset: 0, body: "Hey {first_name}, it's {your_name}. Saw you've got {address} closing soon — hoping it goes smooth for you. Just wanted to say: if anything falls through (it happens more than you'd think), I can close cash in 30 days, no inspections, no contingencies. Hit me up if you need a backup. Reply STOP to opt out." },
    ],
  },
  three_month: {
    label: '3 Month Check-in',
    steps: [
      { dayOffset: 0, body: "Hey {first_name}, it's {your_name} — you asked me to check back around now on {address}. How's everything? Still thinking about selling, or did life take a turn? Reply STOP to opt out." },
    ],
  },
  six_month: {
    label: '6 Month Check-in',
    steps: [
      { dayOffset: 0, body: "Hey {first_name}, it's {your_name}. Time flies — it's been about 6 months since we talked about {address}. Just checking in: anything changed on your end? No rush, just keeping in touch like you asked. Reply STOP to opt out." },
    ],
  },
};

function firstName(owners) {
  if (!owners) return 'there';
  // "DAVID & AMY JENKINS" → "David"; "JANE DOE" → "Jane"
  const cleaned = owners.replace(/[·,&]/g, ' ').split(/\s+/).filter(Boolean);
  if (!cleaned.length) return 'there';
  const first = cleaned[0];
  // Title-case
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}
function shortAddress(addr) {
  if (!addr) return 'your property';
  // Take just the street portion before the first comma
  const parts = addr.split(',');
  return parts[0].trim();
}
function fillTemplate(body, ctx) {
  return body
    .replace(/\{first_name\}/g, ctx.firstName || 'there')
    .replace(/\{address\}/g, ctx.address || 'your property')
    .replace(/\{your_name\}/g, ctx.yourName || '');
}

// ── Twilio inbound webhook handler ──────────────────────────
async function handleTwilioInbound(event) {
  // Twilio sends application/x-www-form-urlencoded
  const params = parseFormEncoded(event.body || '');
  // Optional: verify signature. Skip if AUTH_TOKEN isn't set (e.g. dev).
  if (process.env.TWILIO_AUTH_TOKEN) {
    if (!verifyTwilioSignature(event, params)) {
      return { statusCode: 403, body: 'invalid signature' };
    }
  }
  const from = params.From || '';
  const to   = params.To   || '';
  const body = params.Body || '';
  const sid  = params.MessageSid || '';
  const trimmed = body.trim().toUpperCase();
  const isStop = STOP_KEYWORDS.includes(trimmed);

  // Persist inbound message
  await supa('/messages', 'POST', [{
    twilio_sid: sid,
    to_number: to,
    from_number: from,
    direction: 'inbound',
    body,
    status: 'received',
  }], { Prefer: 'return=minimal' });

  // Pause any active drip campaigns to this number (find via leads.sms_cell)
  try {
    const { json: leads } = await supa(`/leads?sms_cell=eq.${encodeURIComponent(from)}&select=property_id`);
    if (Array.isArray(leads) && leads.length) {
      const propIds = leads.map(l => l.property_id);
      const inList = propIds.map(id => `"${String(id).replace(/"/g, '\\"')}"`).join(',');
      const { json: deals } = await supa(`/deals?property_id=in.(${encodeURIComponent(inList)})&select=id`);
      const dealIds = (deals || []).map(d => d.id);
      if (dealIds.length) {
        const dInList = dealIds.join(',');
        await supa(`/drip_campaigns?deal_id=in.(${dInList})&status=eq.active`, 'PATCH', {
          status: 'paused',
          paused_reason: isStop ? 'opted_out' : 'inbound_reply',
        }, { Prefer: 'return=minimal' });
      }
    }
  } catch (e) { /* non-fatal */ }

  // Handle STOP
  if (isStop) {
    await supa('/sms_opt_outs?on_conflict=e164', 'POST', [{
      e164: from, reason: 'stop_keyword',
    }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
    // Mark the lead as revoked consent
    await supa(`/leads?sms_cell=eq.${encodeURIComponent(from)}`, 'PATCH', {
      sms_consent: 'revoked',
    }, { Prefer: 'return=minimal' });
    // Per Twilio + carrier rules we MUST acknowledge. Reply with confirmation.
    const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>You\'ve been opted out. You won\'t receive any more texts from us. Reply START to resubscribe.</Message></Response>';
    return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: twiml };
  }

  // Empty TwiML response = "received, no auto-reply"
  return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' };
}

// ── Twilio status callback (delivery status updates) ────────
async function handleTwilioStatus(event) {
  const params = parseFormEncoded(event.body || '');
  if (process.env.TWILIO_AUTH_TOKEN) {
    if (!verifyTwilioSignature(event, params)) {
      return { statusCode: 403, body: 'invalid signature' };
    }
  }
  const sid = params.MessageSid || '';
  const status = params.MessageStatus || '';
  if (sid && status) {
    try {
      await supa(`/messages?twilio_sid=eq.${encodeURIComponent(sid)}`, 'PATCH', {
        status,
      }, { Prefer: 'return=minimal' });
    } catch {}
  }
  return { statusCode: 200, body: 'ok' };
}

// ── Drip processor (called by frontend each page load) ──────
// Walks active drip_campaigns and sends any message that's due now.
async function processDueDrips() {
  const now = new Date();
  if (!withinSendWindow(now)) {
    return { processed: 0, skipped: 0, reason: 'outside send window' };
  }
  const yourName = await getAppConfig('sms_business_name') || 'me';
  // Get all active drips
  const { json: drips } = await supa('/drip_campaigns?status=eq.active&select=*&limit=200');
  if (!Array.isArray(drips) || !drips.length) return { processed: 0, skipped: 0 };

  let processed = 0, skipped = 0;
  for (const drip of drips) {
    try {
      const template = DRIP_TEMPLATES[drip.kind];
      if (!template) continue;
      // Find the deal + lead info
      const { json: dealRows } = await supa(`/deals?id=eq.${drip.id ? drip.deal_id : drip.deal_id}&select=*`);
      const deal = dealRows && dealRows[0];
      if (!deal || !deal.property_id) { skipped++; continue; }
      const { json: leadRows } = await supa(`/leads?property_id=eq.${encodeURIComponent(deal.property_id)}&select=sms_consent,sms_cell`);
      const lead = leadRows && leadRows[0];
      if (!lead || !lead.sms_cell || (lead.sms_consent !== 'verbal' && lead.sms_consent !== 'written')) {
        skipped++; continue;
      }
      if (await isOptedOut(lead.sms_cell)) { skipped++; continue; }

      // Which step is next? Look at message log.
      const { json: alreadySent } = await supa(`/messages?campaign_id=eq.${drip.id}&direction=eq.outbound&select=step_index,status&order=step_index.asc`);
      const sentSteps = new Set((alreadySent || []).filter(m => m.status !== 'failed').map(m => m.step_index));
      // Find first un-sent step whose dayOffset is due
      const start = new Date(drip.started_at || drip.trigger_date);
      let didSendOne = false;
      for (let i = 0; i < template.steps.length; i++) {
        if (sentSteps.has(i)) continue;
        const step = template.steps[i];
        const dueAt = new Date(start.getTime() + step.dayOffset * 86400000);
        if (dueAt > now) break; // not due yet
        // Send it
        const body = fillTemplate(step.body, {
          firstName: firstName(deal.owners),
          address: shortAddress(deal.property_address),
          yourName,
        });
        const result = await sendOneSms(lead.sms_cell, body, deal.id, deal.property_id, drip.id, i);
        if (result.ok) { processed++; didSendOne = true; }
        else if (result.skipped && result.reason === 'opted_out') {
          await supa(`/drip_campaigns?id=eq.${drip.id}`, 'PATCH', { status: 'opted_out', paused_reason: 'opted_out' }, { Prefer: 'return=minimal' });
          break;
        }
        else if (result.error) { skipped++; break; }
        // Only send one step per drip per processor run to avoid burst
        break;
      }
      // If all steps are done, mark complete
      if (sentSteps.size + (didSendOne ? 1 : 0) >= template.steps.length) {
        await supa(`/drip_campaigns?id=eq.${drip.id}`, 'PATCH', { status: 'completed' }, { Prefer: 'return=minimal' });
      }
    } catch (e) {
      console.warn('drip step failed', drip.id, e.message);
      skipped++;
    }
  }
  return { processed, skipped };
}

// ════════════════════════════════════════════════════════════════
// EMAIL (Resend) — for buyer-list blasts
// ════════════════════════════════════════════════════════════════

async function sendEmail({ to, subject, html, text, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { error: 'RESEND_API_KEY not set in Netlify env vars' };
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) return { error: 'RESEND_FROM_EMAIL not set (e.g. "Your Name <you@yourdomain.com>")' };

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject: subject || '(no subject)',
      html: html || (text ? text.replace(/\n/g, '<br>') : ''),
      text: text || (html ? html.replace(/<[^>]+>/g, '') : ''),
      reply_to: replyTo || undefined,
    }),
  });
  const j = await r.json();
  if (!r.ok) return { error: j.message || ('HTTP ' + r.status) };
  return { ok: true, id: j.id };
}

// ════════════════════════════════════════════════════════════════
// SUPABASE STORAGE (audio recordings)
// ════════════════════════════════════════════════════════════════

async function uploadToStorage(bucket, path, base64Data, mimeType) {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURIComponent(path)}`;
  const buf = Buffer.from(base64Data, 'base64');
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': mimeType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!r.ok) {
    const txt = await r.text();
    return { error: 'Upload failed: ' + r.status + ' ' + txt };
  }
  return { ok: true, path };
}

async function signedUrl(bucket, path, expiresInSec = 3600) {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/sign/${bucket}/${encodeURIComponent(path)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSec }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.signedURL && !j.signedUrl) return null;
  const rel = j.signedURL || j.signedUrl;
  return process.env.SUPABASE_URL + '/storage/v1' + rel;
}

async function deleteFromStorage(bucket, paths) {
  if (!Array.isArray(paths)) paths = [paths];
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/${bucket}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: paths }),
  });
  return r.ok;
}

async function cleanupExpiredRecordings() {
  const now = new Date().toISOString();
  const { json: expired } = await supa(`/va_recordings?select=id,storage_path&deleted_at=is.null&expires_at=lt.${encodeURIComponent(now)}&limit=100`);
  if (!Array.isArray(expired) || !expired.length) return { deleted: 0 };
  let deleted = 0;
  for (const rec of expired) {
    try {
      await deleteFromStorage('va-recordings', rec.storage_path);
      await supa(`/va_recordings?id=eq.${rec.id}`, 'PATCH', { deleted_at: now }, { Prefer: 'return=minimal' });
      deleted++;
    } catch (e) { /* skip, try next time */ }
  }
  return { deleted };
}

// ── Main handler ──────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };

  const qs   = event.queryStringParameters || {};
  const action = qs.action || '';

  // ─ Twilio webhook (inbound SMS) bypasses password gate ───────
  // It's authenticated via Twilio's signature header.
  // We validate that header separately to make sure the request
  // really came from Twilio.
  if (action === 'twilio-inbound') {
    return await handleTwilioInbound(event);
  }
  if (action === 'twilio-status') {
    return await handleTwilioStatus(event);
  }
  // The drip processor can run via Netlify scheduled function or cron
  // hitting a special key — but to keep it simple, it's behind the
  // password gate like everything else and the admin can trigger it
  // manually, plus the frontend pings it every page load.

  // Password gate
  const expected = process.env.ACCESS_PASSWORD;
  if (!expected) return err('Server misconfigured: ACCESS_PASSWORD not set', 500);
  const provided = event.headers['x-access-password'] || event.headers['X-Access-Password'];
  if (provided !== expected) return err('Unauthorized', 401);

  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch {} }

  try {
    switch (action) {

      // ── Auth ping (used by HTML to verify password) ─────────
      case 'ping':
        return ok({ ok: true });

      // ════════════════════════════════════════════════════════
      // PROPERTIES & LEADS
      // ════════════════════════════════════════════════════════

      // Returns all properties + their phones + lead state
      case 'list-properties': {
        // Supabase default limit is 1000; raise it for larger lists.
        const LIMIT = 50000;
        const { json: props }  = await supa(`/properties?select=id,owners,owner_last_name,property_address,mailing_address,email,imported_at&order=imported_at.asc,id.asc&limit=${LIMIT}`);
        const { json: phones } = await supa(`/phones?select=property_id,e164,display,type&order=property_id.asc,id.asc&limit=${LIMIT}`);
        const { json: leads }  = await supa(`/leads?select=property_id,called,lead_status,notes,va_notes,recording_url,sms_consent,sms_cell&limit=${LIMIT}`);
        const phonesBy = {};
        for (const p of phones || []) (phonesBy[p.property_id] ||= []).push(p);
        const leadsBy = {};
        for (const l of leads || []) leadsBy[l.property_id] = l;
        const out = (props || []).map(p => ({
          ...p,
          phones: phonesBy[p.id] || [],
          lead: leadsBy[p.id] || { called: false, lead_status: '', notes: '', va_notes: '' },
        }));
        return ok({ properties: out });
      }

      // Bulk import. Body: {properties: [{id, owners, property_address, mailing_address, phones:[{e164,display,type}]}], replace: true|false}
      case 'import-properties': {
        const list = Array.isArray(body.properties) ? body.properties : [];
        if (!list.length) return err('No properties to import');

        if (body.replace) {
          // Wipe first. ON DELETE CASCADE clears phones + leads.
          await supa('/properties?id=not.is.null', 'DELETE');
        }

        // Normalize an address for comparison: lowercase, strip punctuation,
        // collapse whitespace (exact-ish matching is safer than over-aggressive fuzzy logic)
        const normAddr = (a) => String(a || '')
          .toLowerCase()
          .replace(/[.,#]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        // ── Dedupe: merge rows with the same ID (last write wins for fields,
        //    union phones). Any row missing a usable ID gets a synthetic one.
        //    Rows sharing the same normalized address within this batch are
        //    also merged together, even if their IDs differ.
        let dupesCollapsed = 0;
        let dupeAddressesSkipped = 0;
        const byId = new Map();
        const seenAddrInBatch = new Map(); // normAddr -> id (first occurrence in this batch)
        let synthCounter = 0;
        for (const raw of list) {
          let id = raw && raw.id != null ? String(raw.id).trim() : '';
          if (!id) id = 'row-' + (++synthCounter);

          const addrKey = normAddr(raw.property_address);

          // If this address was already seen in this batch under a different id,
          // merge into that existing record instead of creating a new one.
          if (addrKey && seenAddrInBatch.has(addrKey)) {
            id = seenAddrInBatch.get(addrKey);
          }

          if (byId.has(id)) {
            // Merge: combine phones (dedup by e164), prefer non-empty fields from later rows
            const existing = byId.get(id);
            const seenPhones = new Set((existing.phones || []).map(p => p.e164));
            for (const ph of (raw.phones || [])) {
              if (ph && ph.e164 && !seenPhones.has(ph.e164)) {
                existing.phones.push(ph);
                seenPhones.add(ph.e164);
              }
            }
            // Fill blanks
            if (!existing.owners && raw.owners) existing.owners = raw.owners;
            if (!existing.property_address && raw.property_address) existing.property_address = raw.property_address;
            if (!existing.mailing_address && raw.mailing_address) existing.mailing_address = raw.mailing_address;
            if (!existing.email && raw.email) existing.email = raw.email;
            if (!existing.va_notes && raw.va_notes) existing.va_notes = raw.va_notes;
            if (!existing.recording_url && raw.recording_url) existing.recording_url = raw.recording_url;
            dupesCollapsed++;
          } else {
            byId.set(id, {
              id,
              owners: raw.owners || '',
              property_address: raw.property_address || '',
              mailing_address: raw.mailing_address || '',
              email: raw.email || '',
              va_notes: raw.va_notes || '',
              recording_url: raw.recording_url || '',
              va_lead: !!raw.va_lead,
              phones: Array.isArray(raw.phones) ? [...raw.phones] : [],
            });
            if (addrKey) seenAddrInBatch.set(addrKey, id);
          }
        }
        let deduped = Array.from(byId.values());

        // ── Cross-check against properties already in the DB. If an address
        //    already exists, merge into that existing row instead of creating
        //    a duplicate property (so re-uploads / overlapping lists don't
        //    create copies).
        const addrToExistingId = new Map();
        {
          const { json: existingProps } = await supa('/properties?select=id,property_address&limit=20000');
          for (const ep of existingProps) {
            const k = normAddr(ep.property_address);
            if (k && !addrToExistingId.has(k)) addrToExistingId.set(k, ep.id);
          }
        }
        deduped = deduped.map(p => {
          const k = normAddr(p.property_address);
          const existingId = k ? addrToExistingId.get(k) : null;
          if (existingId && existingId !== p.id) {
            p.id = existingId;
            dupeAddressesSkipped++;
          }
          return p;
        });

        // Upsert properties
        // Helper: derive owner_last_name from owners string
        const parseLastName = (owners) => {
          if (!owners || !owners.trim()) return '';
          let candidate;
          if (owners.includes(',')) {
            // "LAST, FIRST" → first piece is the last name
            candidate = owners.split(',')[0].trim();
          } else {
            // "FIRST [MI] LAST" or "FIRST & FIRST LAST" → last token before "&"
            const cleaned = owners.replace(/\s+AND\s+/gi, ' & ');
            const firstSeg = cleaned.split('&')[0].trim();
            const tokens = firstSeg.split(/\s+/);
            candidate = tokens[tokens.length - 1] || '';
          }
          // Title-case
          return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
        };

        const propRows = deduped.map(p => ({
          id: p.id,
          owners: p.owners,
          owner_last_name: parseLastName(p.owners),
          property_address: p.property_address,
          mailing_address: p.mailing_address,
          email: p.email || '',
        }));
        for (let i = 0; i < propRows.length; i += 500) {
          await supa('/properties?on_conflict=id', 'POST', propRows.slice(i, i + 500), { Prefer: 'resolution=merge-duplicates,return=minimal' });
        }

        // Replace phones for these properties
        const ids = propRows.map(p => p.id);
        const idChunks = [];
        for (let i = 0; i < ids.length; i += 200) idChunks.push(ids.slice(i, i + 200));
        for (const chunk of idChunks) {
          const inList = chunk.map(id => `"${id.replace(/"/g, '\\"')}"`).join(',');
          await supa(`/phones?property_id=in.(${encodeURIComponent(inList)})`, 'DELETE');
        }
        const phoneRows = [];
        for (const p of deduped) {
          for (const ph of p.phones || []) {
            if (!ph.e164) continue;
            phoneRows.push({
              property_id: p.id,
              e164: ph.e164,
              display: ph.display || ph.e164,
              type: ph.type || '',
            });
          }
        }
        for (let i = 0; i < phoneRows.length; i += 500) {
          await supa('/phones', 'POST', phoneRows.slice(i, i + 500), { Prefer: 'return=minimal' });
        }

        // Persist va_notes + recording_url onto the leads row
        const leadRows = [];
        for (const p of deduped) {
          const va = (p.va_notes || '').trim();
          const rec = (p.recording_url || '').trim();
          if (va || rec) {
            leadRows.push({
              property_id: p.id,
              va_notes: va,
              recording_url: rec,
              updated_at: new Date().toISOString(),
            });
          }
        }
        for (let i = 0; i < leadRows.length; i += 500) {
          await supa('/leads?on_conflict=property_id', 'POST', leadRows.slice(i, i + 500), { Prefer: 'resolution=merge-duplicates,return=minimal' });
        }

        return ok({ imported: propRows.length, phones: phoneRows.length, dupesCollapsed, dupeAddressesSkipped, leadsWithNotes: leadRows.length });
      }

      // Update lead state. Body: {propertyId, called, leadStatus, notes}
      case 'update-lead': {
        if (!body.propertyId) return err('propertyId required');
        const patch = { property_id: String(body.propertyId), updated_at: new Date().toISOString() };
        if ('called'       in body) patch.called        = !!body.called;
        if ('leadStatus'   in body) patch.lead_status   = body.leadStatus || '';
        if ('notes'        in body) patch.notes         = body.notes || '';
        if ('recordingUrl' in body) patch.recording_url = body.recordingUrl || '';
        // Implied: any non-empty status means called
        if (patch.lead_status) patch.called = true;
        await supa('/leads?on_conflict=property_id', 'POST', [patch], { Prefer: 'resolution=merge-duplicates,return=minimal' });
        return ok({ ok: true });
      }

      // ════════════════════════════════════════════════════════
      // TWILIO — NUMBERS
      // ════════════════════════════════════════════════════════

      case 'search-numbers': {
        if (!/^\d{3}$/.test(qs.areaCode || '')) return err('areaCode must be 3 digits');
        const params = new URLSearchParams({ AreaCode: qs.areaCode, VoiceEnabled: 'true', PageSize: '20' });
        if (qs.contains) params.set('Contains', qs.contains);
        const j = await tw(`/Accounts/${twilioSid()}/AvailablePhoneNumbers/US/Local.json?${params}`);
        return ok({
          numbers: (j.available_phone_numbers || []).map(n => ({
            phoneNumber: n.phone_number,
            friendlyName: n.friendly_name,
            locality: n.locality, region: n.region, postalCode: n.postal_code,
            capabilities: {
              voice: !!n.capabilities?.voice,
              SMS:   !!n.capabilities?.SMS,
              MMS:   !!n.capabilities?.MMS,
            },
          })),
        });
      }

      case 'buy-number': {
        if (!body.phoneNumber) return err('phoneNumber required');
        const j = await tw(`/Accounts/${twilioSid()}/IncomingPhoneNumbers.json`, 'POST', { PhoneNumber: body.phoneNumber });
        return ok({ sid: j.sid, phoneNumber: j.phone_number, friendlyName: j.friendly_name });
      }

      case 'list-numbers': {
        const j = await tw(`/Accounts/${twilioSid()}/IncomingPhoneNumbers.json?PageSize=200`);
        return ok({
          numbers: (j.incoming_phone_numbers || []).map(n => ({
            sid: n.sid, phoneNumber: n.phone_number, friendlyName: n.friendly_name,
          })),
        });
      }

      case 'release-number': {
        if (!body.sid) return err('sid required');
        await tw(`/Accounts/${twilioSid()}/IncomingPhoneNumbers/${encodeURIComponent(body.sid)}.json`, 'DELETE');
        return ok({ released: true });
      }

      // ════════════════════════════════════════════════════════
      // TWILIO — CALLS
      // ════════════════════════════════════════════════════════

      // Place a bridge call. Body: {to, from, forwardTo, propertyId}
      case 'make-call': {
        if (!body.to)        return err('to required');
        if (!body.from)      return err('from required');
        if (!body.forwardTo) return err('forwardTo required');
        const twiml = `<Response><Dial callerId="${escapeXml(body.from)}" timeout="30" answerOnBridge="true"><Number>${escapeXml(body.to)}</Number></Dial></Response>`;
        const j = await tw(`/Accounts/${twilioSid()}/Calls.json`, 'POST', {
          From: body.from, To: body.forwardTo, Twiml: twiml,
        });
        // Persist
        try {
          await supa('/calls', 'POST', [{
            twilio_sid: j.sid,
            property_id: body.propertyId ? String(body.propertyId) : null,
            from_number: body.from,
            to_number:   body.to,
            status: j.status || 'queued',
            profile_id: body.profileId || null,
          }], { Prefer: 'return=minimal' });
        } catch (e) { console.warn('call persist failed', e.message); }
        return ok({ sid: j.sid, status: j.status });
      }

      case 'call-status': {
        if (!qs.sid) return err('sid required');
        const j = await tw(`/Accounts/${twilioSid()}/Calls/${encodeURIComponent(qs.sid)}.json`);
        const dur = parseInt(j.duration || '0', 10) || 0;
        // Persist update
        try {
          await supa(`/calls?twilio_sid=eq.${encodeURIComponent(qs.sid)}`, 'PATCH', {
            status: j.status, duration: dur, ended_at: j.end_time || null,
          }, { Prefer: 'return=minimal' });
        } catch (e) { /* non-fatal */ }
        return ok({
          sid: j.sid, status: j.status, duration: dur,
          startTime: j.start_time, endTime: j.end_time,
          from: j.from, to: j.to,
        });
      }

      case 'end-call': {
        if (!body.sid) return err('sid required');
        await tw(`/Accounts/${twilioSid()}/Calls/${encodeURIComponent(body.sid)}.json`, 'POST', { Status: 'completed' });
        return ok({ ended: true });
      }

      // List calls in window (for KPIs/log). Pulls from DB; refreshes any non-final from Twilio first.
      case 'list-calls': {
        const days = Math.max(1, Math.min(366, parseInt(qs.days || '7', 10)));
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const { json: rows } = await supa(`/calls?started_at=gte.${encodeURIComponent(since)}&select=*&order=started_at.desc&limit=500`);
        // Refresh non-final
        const sid = twilioSid();
        const finals = new Set(['completed', 'no-answer', 'busy', 'failed', 'canceled']);
        const updated = [];
        for (const r of rows || []) {
          if (!finals.has(r.status || '')) {
            try {
              const j = await tw(`/Accounts/${sid}/Calls/${encodeURIComponent(r.twilio_sid)}.json`);
              const dur = parseInt(j.duration || '0', 10) || 0;
              if (j.status !== r.status || dur !== r.duration) {
                await supa(`/calls?twilio_sid=eq.${encodeURIComponent(r.twilio_sid)}`, 'PATCH', {
                  status: j.status, duration: dur, ended_at: j.end_time || null,
                }, { Prefer: 'return=minimal' });
                r.status = j.status; r.duration = dur;
              }
            } catch (e) { /* leave row as-is */ }
          }
          updated.push(r);
        }
        return ok({ calls: updated });
      }

      // ════════════════════════════════════════════════════════
      // PROFILES (team members)
      // ════════════════════════════════════════════════════════

      case 'list-profiles': {
        const { json } = await supa('/profiles?select=*&order=name.asc');
        return ok({ profiles: json || [] });
      }

      case 'create-profile': {
        const name = (body.name || '').trim();
        if (!name) return err('name required');
        if (name.length > 40) return err('name too long');
        try {
          const { json } = await supa('/profiles', 'POST', [{ name }]);
          return ok({ profile: json[0] });
        } catch (e) {
          if (String(e.message).match(/duplicate|unique/i)) return err('That name is already taken', 409);
          throw e;
        }
      }

      // ════════════════════════════════════════════════════════
      // DEALS
      // ════════════════════════════════════════════════════════

      // Returns all active deals + summary counts
      case 'list-deals': {
        const { json: deals } = await supa('/deals?select=*&archived=eq.false&order=updated_at.desc&limit=500');
        return ok({ deals: deals || [] });
      }

      // Full deal record including comps, docs, notes
      case 'get-deal': {
        const id = parseInt(qs.id, 10);
        if (!id) return err('id required');
        const { json: deals } = await supa(`/deals?select=*&id=eq.${id}`);
        if (!deals || !deals.length) return err('Deal not found', 404);
        const { json: comps } = await supa(`/deal_comps?select=*&deal_id=eq.${id}&order=id.asc`);
        const { json: docs }  = await supa(`/deal_docs?select=*&deal_id=eq.${id}&order=id.asc`);
        const { json: notes } = await supa(`/deal_notes?select=*&deal_id=eq.${id}&order=created_at.desc`);
        // Also pull call history for this property
        let calls = [];
        if (deals[0].property_id) {
          const { json: c } = await supa(`/calls?select=*&property_id=eq.${encodeURIComponent(deals[0].property_id)}&order=started_at.desc&limit=50`);
          calls = c || [];
        }
        return ok({ deal: deals[0], comps: comps || [], docs: docs || [], notes: notes || [], calls });
      }

      // Create a new deal. Body: {propertyId?, owners, propertyAddress, mailingAddress, sourceList, createdByProfileId, assignedToProfileId, stage?}
      case 'create-deal': {
        const row = {
          property_id:      body.propertyId || null,
          owners:           body.owners || '',
          owner_last_name:  body.ownerLastName || '',
          property_address: body.propertyAddress || '',
          mailing_address:  body.mailingAddress || '',
          source_list:      body.sourceList || '',
          stage:            body.stage || 'hot',
          deal_type:        body.dealType || 'assignment',
          created_by_profile:  body.createdByProfileId || null,
          assigned_to_profile: body.assignedToProfileId || body.createdByProfileId || null,
        };
        const { json } = await supa('/deals', 'POST', [row]);
        const deal = json[0];
        // Auto-log a creation note
        if (deal) {
          try {
            await supa('/deal_notes', 'POST', [{
              deal_id: deal.id,
              profile_id: row.created_by_profile,
              body: 'Deal created from hot lead',
              kind: 'system',
            }], { Prefer: 'return=minimal' });
          } catch (e) { /* non-fatal */ }
        }
        return ok({ deal });
      }

      // Update a deal. Body: {id, ...patch fields...}
      case 'update-deal': {
        const id = parseInt(body.id, 10);
        if (!id) return err('id required');
        // Map camelCase incoming → snake_case DB columns
        const fieldMap = {
          stage: 'stage', dealType: 'deal_type', assignedToProfileId: 'assigned_to_profile',
          arv: 'arv', repairs: 'repairs', sellerAsking: 'seller_asking', yourOffer: 'your_offer',
          maoPercent: 'mao_percent', assignmentFee: 'assignment_fee',
          buyerClosingCosts: 'buyer_closing_costs',
          purchaseClosingCosts: 'purchase_closing_costs', holdingMonthly: 'holding_monthly',
          holdingMonths: 'holding_months', sellingCostsPct: 'selling_costs_pct',
          resalePrice: 'resale_price', sourceList: 'source_list',
          bed: 'bed', bath: 'bath', sqft: 'sqft', yearBuilt: 'year_built',
          owners: 'owners', propertyAddress: 'property_address', mailingAddress: 'mailing_address',
          ownerLastName: 'owner_last_name',
          archived: 'archived',
          // Deal Qualifier Form fields
          qMotivation: 'q_motivation', qTimeline: 'q_timeline', qCondition: 'q_condition',
          qAskingPrice: 'q_asking_price', qMortgageBalance: 'q_mortgage_balance',
          qMonthlyPayment: 'q_monthly_payment', qRepairsNeeded: 'q_repairs_needed',
          qOccupancy: 'q_occupancy', qListedWithAgent: 'q_listed_with_agent',
          qDecisionMakers: 'q_decision_makers', qLiensOrBackTaxes: 'q_liens_or_back_taxes',
          qCallbackTime: 'q_callback_time',
          qReasonToChooseUs: 'q_reason_to_choose_us', qOtherOffers: 'q_other_offers',
          qExtraNotes: 'q_extra_notes',
          qCompletedAt: 'q_completed_at', qCompletedByProfile: 'q_completed_by_profile',
        };
        const patch = {};
        for (const k in body) {
          if (fieldMap[k] !== undefined) {
            patch[fieldMap[k]] = body[k] === '' ? null : body[k];
          }
        }
        if (patch.stage === 'closed' && !patch.closed_at) patch.closed_at = new Date().toISOString();
        if (!Object.keys(patch).length) return ok({ ok: true });
        const { json } = await supa(`/deals?id=eq.${id}`, 'PATCH', patch);
        // If stage changed, log it
        if (body.stage && body._previousStage && body.stage !== body._previousStage) {
          try {
            await supa('/deal_notes', 'POST', [{
              deal_id: id,
              profile_id: body.actingProfileId || null,
              body: 'Moved to ' + body.stage,
              kind: 'stage_change',
            }], { Prefer: 'return=minimal' });
          } catch (e) {}
        }
        return ok({ deal: json && json[0] });
      }

      // Archive (soft-delete) a deal
      case 'archive-deal': {
        const id = parseInt(body.id, 10);
        if (!id) return err('id required');
        await supa(`/deals?id=eq.${id}`, 'PATCH', { archived: true });
        return ok({ archived: true });
      }

      // ── Comps ───────────────────────────────────────────────
      case 'add-comp': {
        const dealId = parseInt(body.dealId, 10);
        if (!dealId) return err('dealId required');
        if (!body.url && !body.label) return err('label or url required');
        const { json } = await supa('/deal_comps', 'POST', [{
          deal_id: dealId, label: body.label || '', url: body.url || '',
          sale_price: body.salePrice || null,
        }]);
        return ok({ comp: json[0] });
      }
      case 'delete-comp': {
        const id = parseInt(body.id, 10);
        if (!id) return err('id required');
        await supa(`/deal_comps?id=eq.${id}`, 'DELETE');
        return ok({ deleted: true });
      }

      // ── Documents ───────────────────────────────────────────
      case 'add-doc': {
        const dealId = parseInt(body.dealId, 10);
        if (!dealId) return err('dealId required');
        if (!body.url) return err('url required');
        const { json } = await supa('/deal_docs', 'POST', [{
          deal_id: dealId, label: body.label || body.url, url: body.url,
          doc_type: body.docType || 'other',
        }]);
        return ok({ doc: json[0] });
      }
      case 'delete-doc': {
        const id = parseInt(body.id, 10);
        if (!id) return err('id required');
        await supa(`/deal_docs?id=eq.${id}`, 'DELETE');
        return ok({ deleted: true });
      }

      // ── Notes ───────────────────────────────────────────────
      case 'add-note': {
        const dealId = parseInt(body.dealId, 10);
        if (!dealId) return err('dealId required');
        if (!body.body || !body.body.trim()) return err('body required');
        const { json } = await supa('/deal_notes', 'POST', [{
          deal_id: dealId, body: body.body.trim(),
          profile_id: body.profileId || null,
          kind: body.kind || 'note',
        }]);
        return ok({ note: json[0] });
      }

      // ── VA Notes on a property/lead ─────────────────────────
      case 'save-va-notes': {
        if (!body.propertyId) return err('propertyId required');
        const patch = {
          property_id: String(body.propertyId),
          va_notes: body.notes || '',
          updated_at: new Date().toISOString(),
        };
        await supa('/leads?on_conflict=property_id', 'POST', [patch], { Prefer: 'resolution=merge-duplicates,return=minimal' });
        return ok({ ok: true });
      }

      // ── Save Deal Qualifier Form (also stamps completion) ──
      case 'save-qualifier': {
        const id = parseInt(body.id, 10);
        if (!id) return err('id required');
        const fields = {
          q_motivation:        body.qMotivation || null,
          q_timeline:          body.qTimeline || null,
          q_condition:         body.qCondition || null,
          q_asking_price:      body.qAskingPrice === '' ? null : body.qAskingPrice,
          q_mortgage_balance:  body.qMortgageBalance === '' ? null : body.qMortgageBalance,
          q_monthly_payment:   body.qMonthlyPayment === '' ? null : body.qMonthlyPayment,
          q_repairs_needed:    body.qRepairsNeeded || null,
          q_occupancy:         body.qOccupancy || null,
          q_listed_with_agent: (body.qListedWithAgent === true || body.qListedWithAgent === 'true') ? true : (body.qListedWithAgent === false || body.qListedWithAgent === 'false') ? false : null,
          q_decision_makers:   body.qDecisionMakers || null,
          q_callback_time:     body.qCallbackTime || null,
          q_liens_or_back_taxes: body.qLiensOrBackTaxes || null,
          q_reason_to_choose_us: body.qReasonToChooseUs || null,
          q_other_offers:      body.qOtherOffers || null,
          q_extra_notes:       body.qExtraNotes || null,
          q_completed_at:      new Date().toISOString(),
          q_completed_by_profile: body.completedByProfileId || null,
        };
        await supa(`/deals?id=eq.${id}`, 'PATCH', fields, { Prefer: 'return=minimal' });
        // Log it
        try {
          await supa('/deal_notes', 'POST', [{
            deal_id: id,
            profile_id: body.completedByProfileId || null,
            body: 'Qualifier form completed',
            kind: 'system',
          }], { Prefer: 'return=minimal' });
        } catch (e) {}
        return ok({ ok: true });
      }

      // ════════════════════════════════════════════════════════
      // CASH BUYERS
      // ════════════════════════════════════════════════════════

      case 'list-buyers': {
        const { json } = await supa('/buyers?select=*&order=active.desc,rating.desc,created_at.desc&limit=500');
        return ok({ buyers: json || [] });
      }

      case 'save-buyer': {
        if (!body.name) return err('name required');
        const row = {
          name: body.name,
          company: body.company || '',
          email: body.email || '',
          phone: body.phone || '',
          city: body.city || '',
          state: body.state || '',
          zip: body.zip || '',
          buy_box: body.buyBox || '',
          min_price: body.minPrice === '' ? null : body.minPrice,
          max_price: body.maxPrice === '' ? null : body.maxPrice,
          property_types: body.propertyTypes || '',
          rehab_level: body.rehabLevel || '',
          cash_only: body.cashOnly !== false,
          funding_proof_on_file: !!body.fundingProofOnFile,
          preferred_areas: body.preferredAreas || '',
          notes: body.notes || '',
          active: body.active !== false,
          rating: parseInt(body.rating || 0, 10) || 0,
        };
        if (body.id) {
          await supa(`/buyers?id=eq.${parseInt(body.id, 10)}`, 'PATCH', row, { Prefer: 'return=minimal' });
          return ok({ ok: true, id: body.id });
        } else {
          row.created_by_profile = body.createdByProfileId || null;
          const { json } = await supa('/buyers', 'POST', [row]);
          return ok({ buyer: json[0] });
        }
      }

      case 'delete-buyer': {
        if (!body.id) return err('id required');
        await supa(`/buyers?id=eq.${parseInt(body.id, 10)}`, 'DELETE');
        return ok({ deleted: true });
      }

      // Send a deal to one or more buyers via email
      // Body: { buyerIds: [...], dealId, subject, body, ccMe? }
      case 'send-deal-to-buyers': {
        const buyerIds = Array.isArray(body.buyerIds) ? body.buyerIds : [];
        if (!buyerIds.length) return err('buyerIds required');
        if (!body.subject) return err('subject required');
        if (!body.body) return err('body required');

        // Fetch deal info (optional — for logging)
        let deal = null;
        if (body.dealId) {
          const { json } = await supa(`/deals?id=eq.${parseInt(body.dealId, 10)}&select=*`);
          deal = json && json[0];
        }

        // Fetch buyers
        const inList = buyerIds.map(i => parseInt(i, 10)).join(',');
        const { json: buyers } = await supa(`/buyers?id=in.(${inList})&select=*`);
        if (!buyers || !buyers.length) return err('No buyers found');

        const results = [];
        for (const b of buyers) {
          if (!b.email) {
            results.push({ buyerId: b.id, name: b.name, status: 'skipped', error: 'No email on file' });
            continue;
          }
          // Personalize {first_name} and {address}
          const fn = (b.name || '').split(/\s+/)[0] || 'there';
          const addr = deal ? (deal.property_address || '') : '';
          const personalizedBody = (body.body || '')
            .replace(/\{first_name\}/g, fn)
            .replace(/\{address\}/g, addr);
          const personalizedSubject = (body.subject || '')
            .replace(/\{first_name\}/g, fn)
            .replace(/\{address\}/g, addr);

          const r = await sendEmail({
            to: b.email,
            subject: personalizedSubject,
            text: personalizedBody,
            replyTo: process.env.RESEND_REPLY_TO || undefined,
          });

          // Log the send
          await supa('/buyer_sends', 'POST', [{
            buyer_id: b.id,
            deal_id: body.dealId || null,
            channel: 'email',
            subject: personalizedSubject,
            body: personalizedBody,
            status: r.ok ? 'sent' : 'failed',
            error_msg: r.error || '',
            sent_by_profile: body.sentByProfileId || null,
          }], { Prefer: 'return=minimal' }).catch(()=>{});

          // Bump stats if sent
          if (r.ok) {
            await supa(`/buyers?id=eq.${b.id}`, 'PATCH', {
              deals_sent: (b.deals_sent || 0) + 1,
              last_sent_at: new Date().toISOString(),
            }, { Prefer: 'return=minimal' }).catch(()=>{});
          }

          results.push({ buyerId: b.id, name: b.name, status: r.ok ? 'sent' : 'failed', error: r.error });
        }

        const sent = results.filter(x => x.status === 'sent').length;
        const failed = results.filter(x => x.status === 'failed').length;
        const skipped = results.filter(x => x.status === 'skipped').length;
        return ok({ results, sent, failed, skipped });
      }

      // Get send history for a deal (so the deal detail can show "sent to: X, Y, Z")
      case 'deal-buyer-sends': {
        const dealId = parseInt(qs.dealId, 10);
        if (!dealId) return err('dealId required');
        const { json } = await supa(`/buyer_sends?deal_id=eq.${dealId}&select=*&order=created_at.desc`);
        return ok({ sends: json || [] });
      }

      // ════════════════════════════════════════════════════════
      // VA RECORDINGS (audio upload + storage)
      // ════════════════════════════════════════════════════════

      case 'list-recordings': {
        const propertyId = qs.propertyId;
        if (!propertyId) return err('propertyId required');
        const { json } = await supa(`/va_recordings?property_id=eq.${encodeURIComponent(propertyId)}&deleted_at=is.null&select=*&order=uploaded_at.desc`);
        const recordings = [];
        for (const r of (json || [])) {
          const url = await signedUrl('va-recordings', r.storage_path, 3600);
          recordings.push({ ...r, playback_url: url });
        }
        return ok({ recordings });
      }

      case 'upload-recording': {
        if (!body.propertyId) return err('propertyId required');
        if (!body.dataBase64) return err('dataBase64 required');
        if (!body.filename) return err('filename required');
        const mime = body.mimeType || 'audio/mpeg';
        const ext = (body.filename.match(/\.([a-z0-9]+)$/i) || [,'m4a'])[1].toLowerCase();
        const path = `${body.propertyId}/${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
        const up = await uploadToStorage('va-recordings', path, body.dataBase64, mime);
        if (up.error) return err(up.error);
        const { json } = await supa('/va_recordings', 'POST', [{
          property_id: String(body.propertyId),
          storage_path: path,
          filename: body.filename,
          mime_type: mime,
          size_bytes: body.sizeBytes || 0,
          duration_sec: body.durationSec || null,
          uploaded_by_profile: body.uploadedByProfileId || null,
        }]);
        return ok({ recording: json[0] });
      }

      case 'delete-recording': {
        if (!body.id) return err('id required');
        const { json } = await supa(`/va_recordings?id=eq.${parseInt(body.id, 10)}&select=storage_path`);
        if (!json || !json[0]) return err('Recording not found', 404);
        await deleteFromStorage('va-recordings', json[0].storage_path);
        await supa(`/va_recordings?id=eq.${parseInt(body.id, 10)}`, 'PATCH', { deleted_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
        return ok({ deleted: true });
      }

      case 'cleanup-recordings': {
        const result = await cleanupExpiredRecordings();
        return ok(result);
      }

      // ════════════════════════════════════════════════════════
      // SMS / DRIP ENDPOINTS
      // ════════════════════════════════════════════════════════

      // Set consent on a lead. Body: {propertyId, consent, cell, by}
      case 'set-sms-consent': {
        if (!body.propertyId) return err('propertyId required');
        const consent = body.consent || 'none';
        if (!['none','verbal','written','revoked'].includes(consent)) return err('Invalid consent value');
        const patch = {
          property_id: String(body.propertyId),
          sms_consent: consent,
          updated_at: new Date().toISOString(),
        };
        if (body.cell) patch.sms_cell = body.cell;
        if (consent === 'verbal' || consent === 'written') {
          patch.sms_consent_at = new Date().toISOString();
          patch.sms_consent_by = body.by || '';
        }
        await supa('/leads?on_conflict=property_id', 'POST', [patch], { Prefer: 'resolution=merge-duplicates,return=minimal' });
        // If revoked, add to opt-out list too
        if (consent === 'revoked' && body.cell) {
          await supa('/sms_opt_outs?on_conflict=e164', 'POST', [{ e164: body.cell, reason: 'manual' }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
        }
        return ok({ ok: true });
      }

      // List messages for a deal
      case 'list-messages': {
        const dealId = parseInt(qs.dealId, 10);
        if (!dealId) return err('dealId required');
        const { json } = await supa(`/messages?deal_id=eq.${dealId}&select=*&order=created_at.asc&limit=500`);
        return ok({ messages: json || [] });
      }

      // Inbox: recent inbound messages across all deals
      case 'list-inbox': {
        const { json: inbound } = await supa('/messages?direction=eq.inbound&select=*&order=created_at.desc&limit=100');
        // Group by from_number, give summary of latest
        const byNum = {};
        for (const m of (inbound || [])) {
          if (!byNum[m.from_number]) byNum[m.from_number] = { from: m.from_number, latest: m, count: 0, dealId: m.deal_id, propertyId: m.property_id };
          byNum[m.from_number].count++;
        }
        // For each unique number, find the deal it belongs to (via leads.sms_cell)
        const threads = Object.values(byNum);
        for (const t of threads) {
          if (t.dealId) continue;
          try {
            const { json: leads } = await supa(`/leads?sms_cell=eq.${encodeURIComponent(t.from)}&select=property_id`);
            const propId = leads && leads[0] ? leads[0].property_id : null;
            if (propId) {
              t.propertyId = propId;
              const { json: deals } = await supa(`/deals?property_id=eq.${encodeURIComponent(propId)}&select=id,property_address,owners&limit=1`);
              if (deals && deals[0]) {
                t.dealId = deals[0].id;
                t.address = deals[0].property_address;
                t.owners = deals[0].owners;
              }
            }
          } catch {}
        }
        return ok({ threads });
      }

      // Send a manual one-off SMS. Body: {dealId, propertyId, to, body}
      case 'send-manual-sms': {
        if (!body.to) return err('to required');
        if (!body.body) return err('body required');
        if (await isOptedOut(body.to)) return err('This number has opted out and cannot be texted.', 400);
        const result = await sendOneSms(body.to, body.body, body.dealId || null, body.propertyId || null, null, null);
        if (result.error) return err(result.error);
        return ok(result);
      }

      // Start a drip campaign (admin approval). Body: {dealId, kind, triggerDate?}
      case 'start-drip': {
        if (!body.dealId) return err('dealId required');
        if (!body.kind || !DRIP_TEMPLATES[body.kind]) return err('Invalid drip kind');
        // Look up the deal + lead
        const { json: dealRows } = await supa(`/deals?id=eq.${body.dealId}&select=*`);
        const deal = dealRows && dealRows[0];
        if (!deal) return err('Deal not found', 404);
        if (!deal.property_id) return err('Deal has no linked property — cannot start drip');
        const { json: leadRows } = await supa(`/leads?property_id=eq.${encodeURIComponent(deal.property_id)}&select=sms_consent,sms_cell`);
        const lead = leadRows && leadRows[0];
        if (!lead || (lead.sms_consent !== 'verbal' && lead.sms_consent !== 'written')) {
          return err('No SMS consent on file. Toggle consent on the Pipeline card first.', 400);
        }
        if (!lead.sms_cell) return err('No cell number on file for SMS.', 400);
        if (await isOptedOut(lead.sms_cell)) return err('That number has opted out.', 400);
        const triggerDate = body.triggerDate ? new Date(body.triggerDate).toISOString() : new Date().toISOString();
        // Upsert (one of each kind per deal)
        await supa('/drip_campaigns?on_conflict=deal_id,kind', 'POST', [{
          deal_id: body.dealId,
          kind: body.kind,
          status: 'active',
          trigger_date: triggerDate,
          started_at: triggerDate,
        }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
        // Process due drips immediately so day-0 messages fire now (within send window)
        const summary = await processDueDrips();
        return ok({ ok: true, summary });
      }

      // Pause / resume / cancel a drip. Body: {id}
      case 'pause-drip': {
        if (!body.id) return err('id required');
        await supa(`/drip_campaigns?id=eq.${body.id}`, 'PATCH', { status: 'paused', paused_reason: 'manual' }, { Prefer: 'return=minimal' });
        return ok({ ok: true });
      }
      case 'resume-drip': {
        if (!body.id) return err('id required');
        await supa(`/drip_campaigns?id=eq.${body.id}`, 'PATCH', { status: 'active', paused_reason: '' }, { Prefer: 'return=minimal' });
        return ok({ ok: true });
      }
      case 'cancel-drip': {
        if (!body.id) return err('id required');
        await supa(`/drip_campaigns?id=eq.${body.id}`, 'PATCH', { status: 'completed', paused_reason: 'cancelled' }, { Prefer: 'return=minimal' });
        return ok({ ok: true });
      }

      // List drips for a deal
      case 'list-drips': {
        const dealId = parseInt(qs.dealId, 10);
        if (!dealId) return err('dealId required');
        const { json } = await supa(`/drip_campaigns?deal_id=eq.${dealId}&select=*&order=created_at.desc`);
        return ok({ drips: json || [] });
      }

      // Process all due drips. Frontend calls this on page load.
      case 'process-drips': {
        const summary = await processDueDrips();
        return ok(summary);
      }

      // SMS config
      case 'get-sms-config': {
        const from = await getAppConfig('sms_from_number');
        const biz  = await getAppConfig('sms_business_name');
        return ok({ from_number: from, business_name: biz });
      }
      case 'set-sms-config': {
        if (typeof body.from_number === 'string') await setAppConfig('sms_from_number', body.from_number);
        if (typeof body.business_name === 'string') await setAppConfig('sms_business_name', body.business_name);
        return ok({ ok: true });
      }

      // ════════════════════════════════════════════════════════
      // CONTRACTS — upload + email via Zoho
      // ════════════════════════════════════════════════════════

      case 'upload-contract': {
        if (!body.dataBase64) return err('dataBase64 required');
        if (!body.filename)   return err('filename required');
        const mime = body.mimeType || 'application/pdf';
        const ext  = (body.filename.match(/\.([a-z0-9]+)$/i) || [,'pdf'])[1].toLowerCase();
        const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g,'_');
        const path = `${Date.now()}_${Math.random().toString(36).slice(2,8)}_${safeName}`;
        const up = await uploadToStorage('contracts', path, body.dataBase64, mime);
        if (up.error) return err(up.error);
        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/contracts/${encodeURIComponent(path)}`;
        return ok({ url: publicUrl, filename: body.filename });
      }

      case 'send-contract': {
        if (!body.toEmail)      return err('toEmail required');
        if (!body.contractUrl)  return err('contractUrl required');
        if (!body.sellerName)   return err('sellerName required');

        const ZOHO_USER = 'leadmanager@zohomail.com';
        const ZOHO_PASS = process.env.ZOHO_APP_PASSWORD || 'i0ZQgzZKQVTN';

        const subject  = body.subject  || `Contract for ${body.propertyAddress || 'your property'}`;
        const message  = body.message  || `Hi ${body.sellerName},\n\nPlease find your contract attached via the link below.\n\n${body.contractUrl}\n\nLet me know if you have any questions.\n\nBest regards`;

        // Send via Zoho SMTP using fetch to smtp2http or nodemailer-style raw SMTP
        // We use Zoho's SMTP via a lightweight raw SMTP approach with node's net/tls
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: 'smtp.zoho.com',
          port: 465,
          secure: true,
          auth: { user: ZOHO_USER, pass: ZOHO_PASS },
        });

        await transporter.sendMail({
          from: `WinWin Dialer <${ZOHO_USER}>`,
          to: body.toEmail,
          subject,
          text: message,
          html: `<p>${message.replace(/\n/g,'<br>')}</p>
                 <p><a href="${body.contractUrl}" style="background:#1a56db;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">📄 Open Contract</a></p>`,
        });

        return ok({ sent: true });
      }

      // ════════════════════════════════════════════════════════
      // E-SIGNATURE — SignWell (Purchase & Sale + Assignment)
      // ════════════════════════════════════════════════════════

      case 'send-for-signature': {
        if (!body.templateId)   return err('templateId required');
        if (!body.signerEmail)  return err('signerEmail required');
        if (!body.signerName)   return err('signerName required');

        const SIGNWELL_KEY = process.env.SIGNWELL_API_KEY || 'YWNjZXNzOjhjOTYxY2I3NDlhMmIzNjAxOTI0ZTVlM2QwY2IzNTA4';

        const payload = {
          template_id: body.templateId,
          name: body.documentName || `Contract — ${body.signerName}`,
          subject: body.subject || 'Please sign your contract',
          message: body.message || `Hi ${body.signerName}, please review and sign the attached document.`,
          recipients: [
            {
              id: '1',
              name: body.signerName,
              email: body.signerEmail,
              placeholder_name: body.placeholderName || 'Signer 1',
            },
          ],
          draft: false,
          test_mode: body.testMode === true,
        };

        // Pre-fill template fields (e.g. purchase price, address, closing date)
        if (body.fields && typeof body.fields === 'object') {
          payload.template_fields = Object.entries(body.fields).map(([api_id, value]) => ({ api_id, value }));
        }

        const resp = await fetch('https://www.signwell.com/api/v1/document_templates/' + encodeURIComponent(body.templateId) + '/documents', {
          method: 'POST',
          headers: {
            'X-Api-Key': SIGNWELL_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        const json = await resp.json();
        if (!resp.ok) return err(json.message || json.error || 'SignWell request failed', resp.status);

        return ok({ document: json });
      }

      case 'check-signature-status': {
        if (!body.documentId) return err('documentId required');
        const SIGNWELL_KEY = process.env.SIGNWELL_API_KEY || 'YWNjZXNzOjhjOTYxY2I3NDlhMmIzNjAxOTI0ZTVlM2QwY2IzNTA4';
        const resp = await fetch('https://www.signwell.com/api/v1/documents/' + encodeURIComponent(body.documentId), {
          headers: { 'X-Api-Key': SIGNWELL_KEY },
        });
        const json = await resp.json();
        if (!resp.ok) return err(json.message || 'Status check failed', resp.status);
        return ok({ status: json.status, document: json });
      }

      // ════════════════════════════════════════════════════════
      // COMPARABLES — PropertyReach
      // ════════════════════════════════════════════════════════

      case 'get-comparables': {
        if (!body.address) return err('address required');

        const PROPERTYREACH_KEY = process.env.PROPERTYREACH_API_KEY || 'test_Od67q03Md5PMJ1xykK9UBhKZbEQe3YlfTk6';

        // Parse "123 Main St, Springfield, NY 11735" into street/city/state/zip.
        // PropertyReach's target object accepts these as separate fields.
        const parts = String(body.address).split(',').map(s => s.trim()).filter(Boolean);
        const target = {};
        if (parts.length >= 3) {
          target.streetAddress = parts[0];
          target.city = parts[1];
          const stateZip = parts.slice(2).join(' ').trim();
          const m = stateZip.match(/^([A-Za-z]{2})\s*([0-9]{5})?/);
          if (m) {
            target.state = m[1].toUpperCase();
            if (m[2]) target.zip = m[2];
          } else {
            target.state = stateZip;
          }
        } else {
          target.streetAddress = body.address;
        }

        const reqBody = {
          target,
          filter: {
            distanceFromSubject: body.radiusMiles || 0.5,
            comparableSource: 'Both',
          },
        };

        const resp = await fetch('https://api.propertyreach.com/v1/comparables', {
          method: 'POST',
          headers: {
            'x-api-key': PROPERTYREACH_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(reqBody),
        });
        const json2 = await resp.json();
        if (!resp.ok) return err((json2 && json2.meta && json2.meta.message) || 'Comparables request failed', resp.status);

        return ok({
          properties: (json2 && json2.properties) || [],
          resultCount: (json2 && json2.meta && json2.meta.resultCount) || 0,
        });
      }

      default:
        return err('Unknown action: ' + action, 404);
    }
  } catch (e) {
    return err(e.message || String(e), e.code && e.code >= 400 && e.code < 600 ? e.code : 500);
  }
};
