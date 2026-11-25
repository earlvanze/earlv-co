(() => {
  const API = 'https://awtangrlqqsdpksarhwo.functions.supabase.co/book-call-earlv';
  const SITE_KEY = '0x4AAAAAAGR3H8fCCpihQYCX';
  const topic = document.body.dataset.topic || 'general';
  const slotsEl = document.getElementById('slots');
  const slotsStatus = document.getElementById('slots-status');
  const selectedEl = document.getElementById('selected-slot');
  const statusEl = document.getElementById('book-status');
  const confirmEl = document.getElementById('confirm');
  const form = document.getElementById('book-form');
  const button = document.getElementById('book-btn');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time';
  let chosen = null;
  let widgetId = null;

  const label = (slot) => new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(slot.start));

  function setStatus(el, text, kind) { el.textContent = text; el.className = kind ? `status ${kind}` : 'status'; }

  function pick(slot, node) {
    slotsEl.querySelectorAll('.slot').forEach((el) => { el.classList.remove('selected'); el.setAttribute('aria-pressed', 'false'); });
    node.classList.add('selected');
    node.setAttribute('aria-pressed', 'true');
    chosen = slot;
    setStatus(selectedEl, `Selected: ${label(slot)} (${zone})`);
  }

  async function loadSlots() {
    chosen = null;
    setStatus(selectedEl, 'No time selected yet.');
    slotsEl.textContent = '';
    try {
      const resp = await fetch(`${API}/availability`, { credentials: 'omit' });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
      const slots = data.slots || [];
      setStatus(slotsStatus, slots.length
        ? `${slots.length} open times in the next ${data.lookaheadDays || 7} days. Times shown in ${zone}.`
        : 'No open times right now. Email earlco@nyu.edu and we will find a time.');
      slots.forEach((slot) => {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'slot';
        node.setAttribute('aria-pressed', 'false');
        node.textContent = label(slot);
        node.addEventListener('click', () => pick(slot, node));
        slotsEl.appendChild(node);
      });
    } catch (err) {
      setStatus(slotsStatus, 'Availability did not load. Reload the page, or email earlco@nyu.edu to book.', 'error');
    }
  }

  function renderConfirmation(data) {
    confirmEl.textContent = '';
    const heading = document.createElement('strong');
    heading.textContent = 'Booking confirmed.';
    confirmEl.append(heading, document.createElement('br'));
    for (const [text, href] of [['Meet link: ', data.meetLink || data.htmlLink], ['Calendar event: ', data.htmlLink]]) {
      if (!href || !/^https:\/\//.test(href)) continue;
      const link = document.createElement('a');
      link.href = href; link.target = '_blank'; link.rel = 'noopener'; link.textContent = href;
      confirmEl.append(text, link, document.createElement('br'));
    }
    confirmEl.hidden = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const email = String(fd.get('email') || '').trim();
    if (!chosen) return setStatus(statusEl, 'Pick a time first.', 'error');
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return setStatus(statusEl, 'Enter your name and a valid email.', 'error');
    if (widgetId === null || !window.turnstile.getResponse(widgetId)) return setStatus(statusEl, 'Complete the verification first.', 'error');
    button.disabled = true;
    confirmEl.hidden = true;
    setStatus(statusEl, 'Creating your booking and Meet link...');
    try {
      const resp = await fetch(`${API}/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
        body: JSON.stringify({
          topic, name, email,
          company: String(fd.get('company') || '').trim(),
          notes: String(fd.get('notes') || '').trim(),
          website: String(fd.get('website') || ''),
          turnstileToken: window.turnstile.getResponse(widgetId),
          start: chosen.start, end: chosen.end,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
      setStatus(statusEl, 'Booked. Check your email for the Google Calendar invitation.', 'success');
      renderConfirmation(data);
      form.reset();
      loadSlots();
    } catch (err) {
      setStatus(statusEl, `Booking failed: ${err.message || 'try again'}`, 'error');
      loadSlots();
    } finally {
      if (widgetId !== null) window.turnstile.reset(widgetId);
      button.disabled = false;
    }
  });

  function renderChallenge() {
    if (!window.turnstile) return setTimeout(renderChallenge, 250);
    widgetId = window.turnstile.render(document.getElementById('challenge'), { sitekey: SITE_KEY, action: 'book_call' });
  }
  renderChallenge();
  loadSlots();
})();
