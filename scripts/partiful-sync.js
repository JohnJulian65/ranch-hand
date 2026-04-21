// One-shot probe of the Partiful API — pulls event details and the guest list
// for the Derby Day event so we can see exactly what fields come back before
// building anything permanent.
//
// Note: the `cerebralvalley/partiful-api` npm package targets the old
// `us-central1-getpartiful.cloudfunctions.net` host, which has been
// decommissioned. Partiful's live API now sits at `api.partiful.com`, so this
// script talks to it directly via fetch.
//
// Auth: expects a Firebase session token in PARTIFUL_AUTH_TOKEN (short TTL,
// ~1 hour — grab a fresh one from the web app when it expires).
//
// Run: `node scripts/partiful-sync.js`
require('dotenv').config();
const fetch = require('node-fetch').default || require('node-fetch');
const cheerio = require('cheerio'); // v1+ named `load` export

const EVENT_ID = 'EAk0YD1wMFqzCxN8EQ3A'; // Capitol Cowboys' Derby Day
const API_BASE = 'https://api.partiful.com';

const token = process.env.PARTIFUL_AUTH_TOKEN;
if (!token) {
  console.error('PARTIFUL_AUTH_TOKEN is not set in .env. Aborting.');
  process.exit(1);
}

async function apiCall(path, params) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({ data: { params } }),
  });
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// Partiful doesn't expose a public-via-API getEvent; it renders the event name
// and start time into the SSR'd event page. Scrape it for the summary fields.
async function scrapeEventPage(eventId) {
  const url = `https://partiful.com/e/${eventId}`;
  const res = await fetch(url);
  const html = await res.text();
  const $ = cheerio.load(html);

  const name = $('meta[property="og:title"]').attr('content')
            || $('h1 span').first().text()
            || null;
  const description = $('meta[property="og:description"]').attr('content') || null;
  const startIso = $('time').attr('datetime') || null;
  const image = $('meta[property="og:image"]').attr('content') || null;
  return { id: eventId, url, name, description, startDateTime: startIso, image };
}

function redact(val) {
  if (!val) return val;
  const s = String(val);
  if (s.length <= 4) return '***';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

(async () => {
  console.log('=== Event details (scraped from public page) ===');
  try {
    const event = await scrapeEventPage(EVENT_ID);
    console.log(JSON.stringify(event, null, 2));
  } catch (err) {
    console.error('scrapeEventPage failed:', err.message);
  }

  console.log('\n=== getGuests(' + EVENT_ID + ') ===');
  try {
    const json = await apiCall('/getGuests', { eventId: EVENT_ID });
    const guests = (json.result && json.result.data) || [];
    console.log('Top-level keys      :', Object.keys(json));
    console.log('result keys         :', Object.keys(json.result || {}));
    console.log('Total guests        :', guests.length);

    // Status distribution
    const statusCounts = {};
    let plusOnesTotal = 0;
    for (const g of guests) {
      statusCounts[g.status] = (statusCounts[g.status] || 0) + 1;
      plusOnesTotal += (g.plusOneCount || (g.plusOnes && g.plusOnes.length) || 0);
    }
    console.log('Status distribution :', statusCounts);
    console.log('Plus-ones total     :', plusOnesTotal);

    // Field shape
    if (guests.length) {
      const g0 = guests[0];
      console.log('\nFirst guest top-level keys:', Object.keys(g0));
      if (g0.user) console.log('user sub-keys              :', Object.keys(g0.user));
      if (g0.rsvpHistory) {
        console.log('rsvpHistory length         :', g0.rsvpHistory.length);
        if (g0.rsvpHistory[0]) console.log('rsvpHistory[0] keys        :', Object.keys(g0.rsvpHistory[0]));
      }
    }

    // Redacted sample of first 3 guests so you can see the shape
    // without dumping 246 people's names/phones into the console.
    console.log('\n=== Sample of first 3 guests (names redacted) ===');
    for (const g of guests.slice(0, 3)) {
      const sample = {
        id: g.id,
        status: g.status,
        count: g.count,
        rsvpDate: g.rsvpDate,
        plusOneCount: g.plusOneCount,
        plusOnes: g.plusOnes,
        anchorGuestId: g.anchorGuestId,
        invitedBy: g.invitedBy,
        name: redact(g.name),
        user: g.user ? {
          id: g.user.id,
          // Redact PII-ish fields
          firstName: redact(g.user.firstName),
          lastName: redact(g.user.lastName),
          username: redact(g.user.username),
          // Leave structural fields so we can see the shape
          hasProfileImage: Boolean(g.user.profileImage || g.user.photoUrl),
          keys: Object.keys(g.user),
        } : null,
      };
      console.log(JSON.stringify(sample, null, 2));
    }

    console.log('\nTip: remove the redact() calls or inspect the raw data directly if you need unredacted names.');
  } catch (err) {
    console.error('getGuests failed:', err.message);
  }
})().catch(err => {
  console.error('Unexpected failure:', err);
  process.exit(1);
});
