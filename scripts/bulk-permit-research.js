#!/usr/bin/env node
/**
 * Bulk permit research — uses Anthropic tool-use + Brave Search to look up
 * actual municipal ordinances for each municipality in public/data/master.json,
 * then writes the findings onto your running board through its API.
 *
 * Needs (environment, never committed):
 *   ANTHROPIC_API_KEY      the Anthropic API key
 *   ANTHROPIC_MODEL        optional — the model (default claude-sonnet-5-5, as on the server)
 *   BRAVE_SEARCH_API_KEY   optional — without it the model answers from training data
 *   APP_URL                your board, e.g. https://territory.example.com
 *   CGT_EMAIL / CGT_PASSWORD   an ADMIN account on that board
 *
 * Usage:
 *   node scripts/bulk-permit-research.js
 *   ... --dry-run          (research but don't push)
 *   ... --state MA         (only one state)
 *   ... --color GREY       (target GREY ZIPs instead of YELLOW)
 *   ... --zip 02451        (single ZIP)
 */

require('dotenv').config({ quiet: true });
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs   = require('fs');

const { settings } = require('../lib/settings');
const APP_URL     = String(process.env.APP_URL || '').replace(/\/$/, '');
const AUTH_EMAIL  = process.env.CGT_EMAIL || '';
const AUTH_PASS   = process.env.CGT_PASSWORD || '';
const API_KEY     = process.env.ANTHROPIC_API_KEY;
const MODEL       = (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5').trim();
const BRAVE_KEY   = process.env.BRAVE_SEARCH_API_KEY;
const MASTER_PATH = path.join(__dirname, '../public/data/master.json');
// Local copy of every result (git-ignored): a re-run or a failed push loses nothing.
const RESULTS_PATH = path.join(__dirname, 'output', 'permit-research-results.json');
const CONCURRENCY = 3;   // parallel municipalities

const args = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const FORCE        = args.includes('--force');   // re-research even if already done
const STATE_FILTER = args.includes('--state') ? args[args.indexOf('--state') + 1] : null;
const COLOR_FILTER = args.includes('--color') ? args[args.indexOf('--color') + 1].toUpperCase() : null;
const ZIP_FILTER   = args.includes('--zip')   ? args[args.indexOf('--zip')   + 1] : null;

if (!API_KEY)   { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }
if (!APP_URL || !AUTH_EMAIL || !AUTH_PASS) { console.error('Set APP_URL, CGT_EMAIL and CGT_PASSWORD (an admin account on your board)'); process.exit(1); }
if (!BRAVE_KEY) { console.warn('Warning: BRAVE_SEARCH_API_KEY not set — research will use training data only'); }

const client = new Anthropic.default({ apiKey: API_KEY });

// ── Brave Search ──────────────────────────────────────────────────────────────
async function braveSearch(query) {
  if (!BRAVE_KEY) return 'Search unavailable — no BRAVE_SEARCH_API_KEY';
  try {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`,
      { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_KEY } }
    );
    const d = await r.json();
    const hits = (d.web?.results || []).slice(0, 5);
    if (!hits.length) return 'No results found.';
    return hits.map(x => `TITLE: ${x.title}\nURL: ${x.url}\nSNIPPET: ${(x.description||'').slice(0,400)}`).join('\n\n');
  } catch(e) {
    return `Search error: ${e.message}`;
  }
}

// ── Research one municipality via tool-use loop ───────────────────────────────
const SEARCH_TOOL = [{
  name: 'search_web',
  description: 'Search the web for municipal ordinances about door-to-door soliciting / canvassing / peddling permits for a specific town.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Specific search query including town name, state, and terms like "solicitors permit ordinance municipal code"' }
    },
    required: ['query']
  }
}];

const SYSTEM = `You are a permit compliance researcher for a door-to-door residential canvassing company in ${settings.research.region || 'the United States'}.

Your task: find the SPECIFIC local ordinance section governing door-to-door soliciting/canvassing in the given municipality, AND the exact practical details a field team needs before showing up — not just "a fee applies."

Use search_web in this order:
1. Search: "[town] [state] solicitors canvassers peddlers permit ordinance municipal code"
2. Search: "[town] [state] door-to-door canvassing permit site:ecode360.com OR site:municode.com OR site:[town].gov"
3. If the EXACT fee amount or processing/turnaround time was not in those results, run targeted follow-ups before giving up:
   - "[town] [state] solicitor permit fee amount"
   - "[town] [state] peddler license application how long processing time"
4. Note any background check, fingerprinting, photo ID, or insurance/bond requirements explicitly — these are usually listed in the same ordinance section.

Do not settle for "a fee is required" or "apply in advance" — find the dollar figure and the number of days/turnaround, and only give up after the targeted follow-up searches in step 3 also come up empty.

Return a JSON object:
{
  "status": "GREEN" | "YELLOW" | "RED",
  "summary": "one-liner with specifics, e.g. '[Town] Code Ch.169 §3 Solicitor Permit — $30/person, 7-day lead time, Town Clerk'",
  "fee": "exact dollar amount and what it covers, e.g. '$30 per canvasser, $5 replacement card' — or 'Not specified in ordinance' only if step 3 follow-up search also failed",
  "processing_time": "exact turnaround, e.g. '5 business days' or 'Issued same-day at Town Clerk counter' — or 'Not specified' only if step 3 follow-up search also failed",
  "permit_process": "numbered steps including exact requirements: 1. ... 2. ... 3. ... (mention background check / fingerprinting / photo ID / insurance if the ordinance requires them)",
  "authority": "exact office + address",
  "hours": "e.g. '9:00am–8:00pm Mon–Sat, no Sundays'",
  "days_restricted": "e.g. 'No Sunday canvassing' or 'None specified in ordinance'",
  "other_restrictions": "badge/ID requirements, no-solicitation registry, etc.",
  "ordinance_ref": "e.g. '[Town] Code Ch.169 §3'"
}

GREEN = no permit required (confirm explicitly — genuinely rare).
YELLOW = permit required but obtainable.
RED = canvassing banned or permit not obtainable.

Do NOT fabricate specific fees, processing times, hours, or ordinance citations. If genuinely not published anywhere after the step 3 follow-ups, be honest:
  fee: "Not specified in ordinance — verify with Town Clerk"
  processing_time: "Not specified in ordinance — verify with Town Clerk"
  summary: "Permit likely required — specific ordinance not located; verify with Town Clerk before fielding"
  authority: "Town Clerk (verify address)"

Return ONLY the JSON object. No other text.`;

async function researchMunicipality(name, state) {
  const messages = [{ role: 'user', content: `Research door-to-door canvassing permit requirements for ${name}, ${state}.` }];
  let iters = 0;
  while (iters < 8) {
    iters++;
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: SEARCH_TOOL,
      messages,
    });

    if (resp.stop_reason === 'end_turn') {
      const text = resp.content.find(c => c.type === 'text')?.text || '{}';
      const match = text.match(/\{[\s\S]*\}/);
      return JSON.parse(match ? match[0] : '{}');
    }

    if (resp.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults = [];
      for (const tu of resp.content.filter(c => c.type === 'tool_use')) {
        const content = await braveSearch(tu.input.query);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content });
      }
      // Moving breakpoint on the newest results so each of the 8 rounds reads
      // the accumulated search transcript back from cache rather than paying
      // for it again. Clear the previous marker — only four fit per request.
      for (const m of messages)
        if (Array.isArray(m.content))
          for (const b of m.content) if (b && typeof b === 'object') delete b.cache_control;
      if (toolResults.length) toolResults[toolResults.length - 1].cache_control = { type: 'ephemeral' };
      messages.push({ role: 'user', content: toolResults });
    }
  }
  throw new Error('Research loop exceeded max iterations');
}

// ── Board auth / edits ────────────────────────────────────────────────────────
async function getAuthCookie() {
  const resp = await fetch(`${APP_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: AUTH_EMAIL, password: AUTH_PASS }),
  });
  const raw = resp.headers.get('set-cookie') || '';
  const m = raw.match(/cgt_session=([^;]+)/);
  if (!resp.ok || !m) throw new Error(`Sign-in failed (status ${resp.status})`);
  return `cgt_session=${m[1]}`;
}

async function fetchEdits(cookie) {
  return fetch(`${APP_URL}/api/edits`, { headers: { Cookie: cookie } }).then(r => r.json());
}

async function pushEdits(cookie, payload) {
  return fetch(`${APP_URL}/api/edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  }).then(r => r.json());
}

function chunk(arr, n) { const o=[]; for(let i=0;i<arr.length;i+=n) o.push(arr.slice(i,i+n)); return o; }

async function withConcurrency(tasks, limit) {
  const pool = []; const results = [];
  for (const t of tasks) {
    const p = t().then(v => { results.push(v); pool.splice(pool.indexOf(p),1); });
    pool.push(p);
    if (pool.length >= limit) await Promise.race(pool);
  }
  await Promise.all(pool);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Bulk Permit Research (with web search) ===');
  if (DRY_RUN) console.log('[DRY RUN]\n');
  if (!BRAVE_KEY) console.log('[WARNING: no search key — using training data only]\n');

  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8'));

  // Determine target ZIPs
  let targets = master;
  if (ZIP_FILTER)   targets = targets.filter(r => r.zip === ZIP_FILTER);
  if (STATE_FILTER) targets = targets.filter(r => r.state === STATE_FILTER);
  if (COLOR_FILTER) targets = targets.filter(r => r.color === COLOR_FILTER);
  else if (!ZIP_FILTER) targets = targets.filter(r => r.color === 'YELLOW');

  // Group by municipality + state
  const muniMap = {};
  for (const r of targets) {
    const muni = r.municipality || r.primary_city;
    const key  = `${muni}|${r.state}`;
    if (!muniMap[key]) muniMap[key] = { name: muni, state: r.state, zips: [] };
    muniMap[key].zips.push(r.zip);
  }

  console.log(`Target ZIPs: ${targets.length}  |  Municipalities: ${Object.keys(muniMap).length}`);

  // Auth + check existing
  console.log('Authenticating…');
  const cookie = await getAuthCookie();
  console.log('Auth OK');
  const existingEdits = await fetchEdits(cookie);

  // Skip already web-searched municipalities with a real fee/processing_time (unless --force)
  const toResearch = FORCE
    ? Object.values(muniMap)
    : Object.values(muniMap).filter(m =>
        m.zips.some(zip => {
          const e = existingEdits[zip] || {};
          // Skip only if fee AND processing_time were actually found (not "Not specified")
          const hasFee  = e.fee && !/not specified/i.test(e.fee);
          const hasTime = e.processing_time && !/not specified/i.test(e.processing_time);
          if (e.ordinance_ref && hasFee && hasTime) return false;
          return true;
        })
      );

  console.log(`To research: ${toResearch.length}  (skipping ${Object.keys(muniMap).length - toResearch.length} already done)\n`);
  if (!toResearch.length) { console.log('Nothing to do.'); return; }

  const allResults = {};
  let done = 0;

  const tasks = toResearch.map(m => async () => {
    const label = `${m.name}, ${m.state}`;
    try {
      const result = await researchMunicipality(m.name, m.state);
      const status = ['GREEN', 'YELLOW', 'RED'].includes(result.status) ? result.status : 'YELLOW';
      // The board accepts plain text only; model output can come back as a list.
      const aiText = v => (typeof v === 'string' || typeof v === 'number') ? String(v).slice(0, 4000) : '';
      const symbol = status === 'GREEN' ? '🟢' : status === 'RED' ? '🔴' : '🟡';
      done++;
      console.log(`[${done}/${toResearch.length}] ${symbol} ${label}${result.ordinance_ref ? ' — ' + result.ordinance_ref : ''}`);

      for (const zip of m.zips) {
        const existingColor = (existingEdits[zip] || {}).color || master.find(r => r.zip === zip)?.color || 'YELLOW';
        const newColor = existingColor === 'YELLOW' || existingColor === 'GREY' ? status : existingColor;
        allResults[zip] = {
          color:               newColor,
          permit_required:     status === 'GREEN' ? 'N' : 'Y',
          permit_summary:      aiText(result.summary)       || '',
          fee:                 aiText(result.fee)            || '',
          processing_time:     aiText(result.processing_time) || '',
          permit_process:      aiText(result.permit_process) || '',
          authority:           aiText(result.authority)      || '',
          hours:               aiText(result.hours)          || '',
          days_restricted:     aiText(result.days_restricted) || '',
          other_restrictions:  aiText(result.other_restrictions) || '',
          ordinance_ref:       aiText(result.ordinance_ref)  || '',
          verification_status: `AI-researched ${new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(new Date())} — verify before fielding`,
        };
      }
    } catch(e) {
      console.error(`  ✗ ${label}: ${e.message}`);
    }
  });

  await withConcurrency(tasks, CONCURRENCY);

  // Save local backup
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  const existing = fs.existsSync(RESULTS_PATH) ? JSON.parse(fs.readFileSync(RESULTS_PATH,'utf8')) : {};
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ ...existing, ...allResults }, null, 2));
  console.log(`\nResults saved (${Object.keys(allResults).length} ZIPs)`);

  if (DRY_RUN) { console.log('[DRY RUN] Would push. Done.'); return; }

  console.log(`Pushing ${Object.keys(allResults).length} updates to ${APP_URL}…`);
  for (const [i, ch] of chunk(Object.entries(allResults), 100).entries()) {
    const r = await pushEdits(cookie, Object.fromEntries(ch));
    console.log(`  Chunk ${i+1} ${r.ok ? 'OK' : 'FAILED: ' + JSON.stringify(r)}`);
  }
  console.log('\n=== Done ===');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
