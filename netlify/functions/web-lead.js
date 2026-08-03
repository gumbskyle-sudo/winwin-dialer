/* Win Win Call to Close — Website lead intake
 * ────────────────────────────────────────────
 * PUBLIC endpoint (no ACCESS_PASSWORD) so winwinproperties.net can post to it.
 * Lives at:  /.netlify/functions/web-lead
 *
 * Creates (or merges into) a property + phone + lead row, flags the lead
 * red, and stamps source so website leads are filterable in the app.
 *
 * Uses the same env vars api.js already has:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Password',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}
const ok = (b, c = 200) => ({ statusCode: c, headers: corsHeaders(), body: JSON.stringify(b) });
const err = (m, c = 400) => ({ statusCode: c, headers: corsHeaders(), body: JSON.stringify({ error: m }) });

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
  const headers = {
    apikey: supaKey(),
    Authorization: 'Bearer ' + supaKey(),
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(extraHeaders || {}),
  };
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(supaUrl() + '/rest/v1' + path, init);
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) {
    const e = new Error((json && (json.message || json.error)) || `Supabase HTTP ${r.status}`);
    e.code = r.status;
    throw e;
  }
  return { json };
}

// "(302) 526-1537" → "+13025261537". Returns '' if it can't be normalized.
function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length > 11) return '+' + d;
  return '';
}

const normAddr = (a) => String(a || '')
  .toLowerCase()
  .replace(/[.,#]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Build the VA-notes blob so the qualifiers are readable on the lead card
// even before any UI work is done.
function qualifierNotes(b) {
  const lines = [];
  const add = (label, v) => {
    const val = String(v == null ? '' : v).trim();
    if (val && val.toLowerCase() !== 'not provided') lines.push(`${label}: ${val}`);
  };
  add('Asking price', b.asking_price);
  add('Mortgage balance', b.mortgage_balance);
  add('Condition', b.condition);
  add('Timeline', b.timeline);
  add('Email', b.email);
  if (b.message) add('Message', b.message);
  const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  lines.push(`— ${b.source || 'Website'} lead, ${stamp}`);
  return lines.join('\n');
}

// ── Actions ───────────────────────────────────────────────────
// (no action)  → public intake from winwinproperties.net
// ?action=list → dialer asks for its website leads   (password required)
// ?action=seen → dialer marks them read              (password required)

function authed(event) {
  const expected = process.env.ACCESS_PASSWORD;
  const given = event.headers['x-access-password'] || event.headers['X-Access-Password'];
  return !!expected && given === expected;
}

async function handleList() {
  const { json } = await supa(
    '/leads?source=neq.&select=property_id,source,web_lead_at,lead_seen,highlight&order=web_lead_at.desc&limit=500'
  );
  return ok({ leads: json || [] });
}

async function handleSeen() {
  await supa('/leads?lead_seen=eq.false', 'PATCH', { lead_seen: true }, { Prefer: 'return=minimal' });
  return ok({ ok: true });
}

async function handleIntake(event) {
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }

  // Honeypot — bots fill hidden fields. Pretend success, save nothing.
  if (b.website && String(b.website).trim()) return ok({ ok: true, skipped: 'bot' });

  const address = String(b.address || '').trim();
  const phoneRaw = String(b.phone || '').trim();
  if (!address && !phoneRaw) return err('address or phone required');

  const e164 = toE164(phoneRaw);
  const source = String(b.source || 'Website').trim();
  const name = String(b.name || '').trim();

  // ── Find an existing property with this address (avoid duplicates) ──
  let propertyId = null;
  const key = normAddr(address);
  if (key) {
    const { json: existing } = await supa('/properties?select=id,property_address&limit=20000');
    for (const p of existing || []) {
      if (normAddr(p.property_address) === key) { propertyId = p.id; break; }
    }
  }

  const isNew = !propertyId;
  if (isNew) propertyId = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

  await supa('/properties?on_conflict=id', 'POST', [{
    id: propertyId,
    owners: name || 'Website Lead',
    owner_last_name: name ? (name.trim().split(/\s+/).pop() || '') : '',
    property_address: address,
    mailing_address: '',
    email: String(b.email || '').trim(),
  }], { Prefer: 'resolution=merge-duplicates,return=minimal' });

  if (e164) {
    const { json: havePhones } = await supa(
      `/phones?property_id=eq.${encodeURIComponent(propertyId)}&select=e164`
    );
    if (!(havePhones || []).some(p => p.e164 === e164)) {
      await supa('/phones', 'POST', [{
        property_id: propertyId, e164, display: phoneRaw || e164, type: 'Cell',
      }], { Prefer: 'return=minimal' });
    }
  }

  const leadRow = {
    property_id: propertyId,
    highlight: 'red',
    source,
    va_notes: qualifierNotes({ ...b, source }),
    updated_at: new Date().toISOString(),
    web_lead_at: new Date().toISOString(),
    lead_seen: false,
  };
  if (e164) leadRow.sms_cell = e164;

  try {
    await supa('/leads?on_conflict=property_id', 'POST', [leadRow], {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    });
  } catch (e) {
    // Migration not run yet — never lose a lead to a missing column.
    delete leadRow.source; delete leadRow.web_lead_at; delete leadRow.lead_seen;
    await supa('/leads?on_conflict=property_id', 'POST', [leadRow], {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  return ok({ ok: true, propertyId, isNew });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const action = (event.queryStringParameters || {}).action || '';

  try {
    if (action === 'list' || action === 'seen') {
      if (!authed(event)) return err('Unauthorized', 401);
      return action === 'list' ? await handleList() : await handleSeen();
    }
    return await handleIntake(event);
  } catch (e) {
    console.error('web-lead failed:', e.message);
    return err(e.message || 'Server error', 500);
  }
};
