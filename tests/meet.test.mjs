import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const pages = { 'meet/index.html': ['general', '/'], 'meet/real-estate.html': ['real-estate', '/real-estate'], 'meet/consulting.html': ['consulting', '/consulting'] };

test('each booking page has its topic, canonical URL and an agent path', async () => {
  for (const [file, [topic, path]] of Object.entries(pages)) {
    const html = await read(file);
    assert.match(html, new RegExp(`<body data-topic="${topic}">`, 'u'));
    assert.match(html, new RegExp(`rel="canonical" href="https://meet\\.earlv\\.co${path}"`, 'u'));
    const options = JSON.parse(html.match(/id="booking-options">([\s\S]*?)<\/script>/u)[1]);
    assert.equal(options.topic, topic);
    assert.match(options.availability.url, /\/book-call-earlv\/availability$/u);
    assert.ok(options.agents.to.includes('@'));
    assert.match(html, /name="website"[^>]*tabindex="-1"/u, 'honeypot present');
    assert.doesNotMatch(html, /<script>/u, 'no inline scripts under the CSP');
  }
});

test('real-estate page keeps the Calendly wording and makes no income claims', async () => {
  const html = await read('meet/real-estate.html');
  assert.match(html, /exchange of ideas on how you can advance your personal and business goals/u);
  assert.match(html, /over seven years of experience as a successful real estate investor/u);
  assert.match(html, /Renatus/u);
  assert.doesNotMatch(html, /guarantee|passive income|\$\d/iu);
});

test('script posts the topic with a Turnstile token to the earlv function only', async () => {
  const js = await read('meet/book.js');
  assert.match(js, /book-call-earlv'/u);
  assert.doesNotMatch(js, /book-call-tekiz|\/book-call\/(availability|create)/u);
  assert.match(js, /topic, name, email/u);
  assert.match(js, /turnstileToken:/u);
  assert.doesNotMatch(js, /innerHTML/u);
});

test('headers allow only the booking function and Turnstile', async () => {
  const h = await read('meet/_headers');
  assert.match(h, /connect-src 'self' https:\/\/awtangrlqqsdpksarhwo\.functions\.supabase\.co;/u);
  assert.match(h, /script-src 'self' https:\/\/challenges\.cloudflare\.com;/u);
  assert.match(h, /frame-ancestors 'none'/u);
  assert.doesNotMatch(h, /unsafe-inline/u);
});

test('function allows only meet.earlv.co and verifies the Turnstile host', async () => {
  const fn = await read('ops/supabase/book-call-earlv/index.ts');
  const hosts = fn.match(/ALLOWED_ORIGIN_HOSTS = new Set\(\[([\s\S]*?)\]\)/u)[1];
  assert.match(hosts, /"meet\.earlv\.co"/u);
  assert.doesNotMatch(hosts, /tekiz|aops/u);
  assert.match(fn, /result\.hostname === "meet\.earlv\.co"/u);
  assert.match(fn, /BOOK_CALL_EARLV_TURNSTILE_SECRET/u);
  for (const t of ['general', 'real-estate', 'consulting']) assert.match(fn, new RegExp(`"?${t}"?: \\{`, 'u'));
  assert.match(fn, /const eventId = `tkb/u, 'shares the slot claim with the tekiz.ai and aops calendars');
});

test('earlv.co/book redirects to the meet subdomain', async () => {
  const r = await read('_redirects');
  assert.match(r, /^\/book https:\/\/meet\.earlv\.co\/ 302$/mu);
});
