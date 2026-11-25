const ALLOWED_ORIGIN_HOSTS = new Set([
  "meet.earlv.co",
  "localhost",
  "127.0.0.1",
]);
const CORS_ALLOWED_HEADERS = "content-type, authorization, apikey, x-client-info";

const DEFAULT_TZ = Deno.env.get("BOOK_CALL_TIMEZONE") || "Europe/Madrid";
const DEFAULT_DAYS = Number(Deno.env.get("BOOK_CALL_LOOKAHEAD_DAYS") || "10");
const DEFAULT_SLOT_MINUTES = Number(Deno.env.get("BOOK_CALL_SLOT_MINUTES") || "30");
const DEFAULT_BUFFER_MINUTES = Number(Deno.env.get("BOOK_CALL_BUFFER_MINUTES") || "15");
const DEFAULT_WORK_START_HOUR = Number(Deno.env.get("BOOK_CALL_START_HOUR") || "13");
const DEFAULT_WORK_END_HOUR = Number(Deno.env.get("BOOK_CALL_END_HOUR") || "22");
const DEFAULT_CALENDAR_ID = Deno.env.get("GOOGLE_CALENDAR_ID") || "primary";
const DEFAULT_IMPERSONATE = Deno.env.get("GOOGLE_IMPERSONATE_USER") || "";
const SERVICE_ACCOUNT_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") || "";
const DESCRIPTION_LINES = (source: string) => [
  `Call booked from ${source}`,
  "",
  "Google Meet: {meet link}",
  "",
  "Guest: {guest name}",
  "Email: {guest email}",
  "Phone: {guest phone}",
  "Company: {guest company}",
  "",
  "What would you like to talk about?",
  "{client input}",
].join("\n");

const TOPICS: Record<string, { title: string; description: string }> = {
  general: {
    title: "{guest full name} <> Earl Co",
    description: DESCRIPTION_LINES("meet.earlv.co"),
  },
  "real-estate": {
    title: "{guest full name} <> Earl Co | Real Estate Investing",
    description: DESCRIPTION_LINES("meet.earlv.co/real-estate"),
  },
  consulting: {
    title: "{guest full name} <> Earl Co | Tech Consulting",
    description: DESCRIPTION_LINES("meet.earlv.co/consulting"),
  },
};
const topicOf = (value: unknown): string => (typeof value === "string" && value in TOPICS ? value : "general");

type Json = Record<string, unknown>;

type BookingPayload = {
  name: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
  start: string;
  end: string;
};

function firstName(fullName: string): string {
  const cleaned = fullName.trim();
  return cleaned ? cleaned.split(/\s+/)[0] : "Guest";
}

function renderTemplate(
  template: string,
  payload: { name: string; email: string; phone?: string; company: string; notes: string; meetLink?: string },
): string {
  const fullName = payload.name || "Guest";
  const lastName = fullName.trim().split(/\s+/).slice(1).join(" ");
  return template
    .replaceAll("{guest first name}", firstName(fullName))
    .replaceAll("{guest last name}", lastName)
    .replaceAll("{guest full name}", fullName)
    .replaceAll("{guest name}", fullName)
    .replaceAll("{guest email}", payload.email || "")
    .replaceAll("{guest phone}", payload.phone || "")
    .replaceAll("{guest company}", payload.company || "")
    .replaceAll("{client input}", payload.notes || "")
    .replaceAll("{meet link}", payload.meetLink || "Generated after booking")
    .trim();
}

function trimText(value: unknown, maxLen: number): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

async function verifyTurnstile(token: unknown, secret: string, ip: string): Promise<boolean> {
  if (typeof token !== "string" || !token || token.length > 2048 || secret.length < 20) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip && ip !== "unknown") form.set("remoteip", ip);
  try {
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: form, signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const result = await resp.json();
    return result.success === true && result.action === "book_call" &&
      result.hostname === "meet.earlv.co";
  } catch {
    return false;
  }
}

// Best-effort per-isolate limiter: 5 booking attempts per IP per hour.
const attempts = new Map<string, number[]>();
function allowBookingAttempt(ip: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 5) { attempts.set(ip, recent); return false; }
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 5000) attempts.clear();
  return true;
}

function getAllowedOrigin(req: Request): string | null {
  const raw = req.headers.get("origin") || req.headers.get("referer");
  // Direct (non-browser) clients send neither header. Browsers always send
  // Origin on cross-origin requests, so CORS restrictions still apply to them.
  if (!raw) return "https://meet.earlv.co";

  try {
    const url = new URL(raw);
    if (!ALLOWED_ORIGIN_HOSTS.has(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin || "https://meet.earlv.co",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    "Vary": "Origin",
  };
}

function jsonResponse(body: Json, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function parseServiceAccount(): Json {
  if (!SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  const parsed = JSON.parse(SERVICE_ACCOUNT_JSON);
  if (!parsed.client_email || !parsed.private_key || !parsed.token_uri) {
    throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  return parsed;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const clean = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    binary.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function getGoogleAccessToken(scopes: string[]): Promise<string> {
  const sa = parseServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim: Record<string, unknown> = {
    iss: sa.client_email,
    scope: scopes.join(" "),
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };
  if (DEFAULT_IMPERSONATE) claim.sub = DEFAULT_IMPERSONATE;

  const signingInput = `${textToBase64Url(JSON.stringify(header))}.${textToBase64Url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(String(sa.private_key));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );
  const jwt = `${signingInput}.${bytesToBase64Url(sig)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const resp = await fetch(String(sa.token_uri), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token mint failed (${resp.status})`);
  }
  return data.access_token;
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const out: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

function zonedDateLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function timezoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - date.getTime();
}

function zonedTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const guessDate = new Date(guess);
  const offset = timezoneOffsetMs(guessDate, timeZone);
  return guess - offset;
}

function isoWithOffset(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const offsetMinutes = timezoneOffsetMs(date, timeZone) / 60000;
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

async function listBusyRanges(startIso: string, endIso: string): Promise<Array<{ start: number; end: number }>> {
  const token = await getGoogleAccessToken(["https://www.googleapis.com/auth/calendar"]);
  const resp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: startIso,
      timeMax: endIso,
      timeZone: DEFAULT_TZ,
      items: [{ id: DEFAULT_CALENDAR_ID }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Freebusy failed (${resp.status})`);
  const calendar = data.calendars?.[DEFAULT_CALENDAR_ID];
  if (!calendar || (Array.isArray(calendar.errors) && calendar.errors.length) || !Array.isArray(calendar.busy)) {
    throw new Error("Calendar availability is temporarily unavailable.");
  }
  const busy = calendar.busy as Array<{ start: string; end: string }>;
  return busy.map((item: { start: string; end: string }) => ({
    start: new Date(item.start).getTime(),
    end: new Date(item.end).getTime(),
  }));
}

function overlapsBusy(startMs: number, endMs: number, busy: Array<{ start: number; end: number }>): boolean {
  return busy.some((b) => startMs < b.end && endMs > b.start);
}

function parseBookingPayload(payload: Json): BookingPayload {
  return {
    name: trimText(payload.name, 200),
    email: trimText(payload.email, 320).toLowerCase(),
    phone: trimText(payload.phone, 80),
    company: trimText(payload.company, 200),
    notes: trimText(payload.notes, 5000),
    start: trimText(payload.start, 100),
    end: trimText(payload.end, 100),
  };
}

async function getAvailability(): Promise<Json> {
  const now = new Date();
  const nowParts = zonedParts(now, DEFAULT_TZ);
  const windowStartMs = now.getTime() + DEFAULT_BUFFER_MINUTES * 60_000;
  const rangeStartMs = zonedTimeToUtcMs(
    DEFAULT_TZ,
    Number(nowParts.year),
    Number(nowParts.month),
    Number(nowParts.day),
    0,
    0,
    0,
  );
  const rangeEndDate = new Date(rangeStartMs + DEFAULT_DAYS * 24 * 60 * 60_000 + 24 * 60 * 60_000);
  const busy = await listBusyRanges(new Date(rangeStartMs).toISOString(), rangeEndDate.toISOString());

  const slots: Array<Json> = [];
  for (let dayOffset = 0; dayOffset < DEFAULT_DAYS; dayOffset++) {
    // Advance local calendar dates, not elapsed milliseconds, so DST changes
    // cannot duplicate or skip a day.
    const localDay = new Date(Date.UTC(Number(nowParts.year), Number(nowParts.month) - 1, Number(nowParts.day) + dayOffset));
    const year = localDay.getUTCFullYear();
    const month = localDay.getUTCMonth() + 1;
    const day = localDay.getUTCDate();

    for (let hour = DEFAULT_WORK_START_HOUR; hour < DEFAULT_WORK_END_HOUR; hour++) {
      for (let minute = 0; minute < 60; minute += DEFAULT_SLOT_MINUTES) {
        const startMs = zonedTimeToUtcMs(DEFAULT_TZ, year, month, day, hour, minute, 0);
        const endMs = startMs + DEFAULT_SLOT_MINUTES * 60_000;
        if (startMs < windowStartMs) continue;
        if (overlapsBusy(startMs, endMs, busy)) continue;

        const startDate = new Date(startMs);
        const endDate = new Date(endMs);
        slots.push({
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          label: zonedDateLabel(startDate, DEFAULT_TZ),
          timezone: DEFAULT_TZ,
        });
      }
    }
  }

  return {
    slots,
    timezone: DEFAULT_TZ,
    lookaheadDays: DEFAULT_DAYS,
    slotMinutes: DEFAULT_SLOT_MINUTES,
  };
}

async function createBooking(rawPayload: Json): Promise<Json> {
  const payload = parseBookingPayload(rawPayload);
  const { name, email, phone, company, notes, start, end } = payload;
  const topic = TOPICS[topicOf(rawPayload.topic)];

  if (!name || !email || !start || !end) {
    throw new Error("Missing required fields.");
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    throw new Error("Invalid booking window.");
  }

  const offered = await getAvailability();
  const wanted = `${startDate.toISOString()}|${endDate.toISOString()}`;
  const isOffered = (offered.slots as unknown as Array<{ start: string; end: string }>).some(
    (slot) => `${new Date(slot.start).toISOString()}|${new Date(slot.end).toISOString()}` === wanted,
  );
  if (!isOffered) {
    throw new Error("That time is not available. Pick one of the listed slots.");
  }

  const busy = await listBusyRanges(startDate.toISOString(), endDate.toISOString());
  if (overlapsBusy(startDate.getTime(), endDate.getTime(), busy)) {
    throw new Error("That slot is no longer available.");
  }

  const token = await getGoogleAccessToken(["https://www.googleapis.com/auth/calendar"]);
  const renderedTitle = renderTemplate(topic.title, { name, email, phone, company, notes });
  const renderedDescription = renderTemplate(topic.description, { name, email, phone, company, notes });

  // A deterministic event id per slot makes the claim atomic: Google rejects a
  // second insert with the same id (409), so two requests cannot both confirm.
  // Google allows only a-v and 0-9 in client-supplied ids; base-32 digits and this prefix stay inside that set.
  const eventId = `tkb${Math.floor(startDate.getTime() / 60_000).toString(32)}`;
  const body = {
    id: eventId,
    summary: renderedTitle,
    description: renderedDescription,
    start: { dateTime: isoWithOffset(startDate, DEFAULT_TZ), timeZone: DEFAULT_TZ },
    end: { dateTime: isoWithOffset(endDate, DEFAULT_TZ), timeZone: DEFAULT_TZ },
    attendees: [{ email, displayName: name }],
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "email", minutes: 2 },
        { method: "popup", minutes: 2 },
      ],
    },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
  };

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(DEFAULT_CALENDAR_ID)}/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  let data = await resp.json();
  if (resp.status === 409) {
    // The id exists. A cancelled event keeps its id, so restore it for this booking;
    // a confirmed event means the slot is taken.
    const calendarUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(DEFAULT_CALENDAR_ID)}/events/${eventId}`;
    const existing = await (await fetch(calendarUrl, { headers: { Authorization: `Bearer ${token}` } })).json().catch(() => ({}));
    if (existing.status !== "cancelled") throw new Error("That slot was just taken. Pick another time.");
    const restored = await fetch(`${calendarUrl}?conferenceDataVersion=1&sendUpdates=all`, {
      method: "PUT",
      // If-Match makes the restore conditional: a concurrent restore changes the etag and gets 412.
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": String(existing.etag || "") },
      body: JSON.stringify({ ...body, status: "confirmed" }),
    });
    data = await restored.json();
    if (!restored.ok || !existing.etag) throw new Error("That slot was just taken. Pick another time.");
  } else if (!resp.ok) {
    throw new Error(data.error?.message || `Calendar event create failed (${resp.status})`);
  }

  let meetLink = data.hangoutLink || "";
  if (!meetLink && Array.isArray(data.conferenceData?.entryPoints)) {
    meetLink = data.conferenceData.entryPoints.find((x: Json) => x.entryPointType === "video")?.uri || "";
  }
  // Conference creation can still be pending when the event is returned; poll briefly for the Meet link.
  for (let attempt = 0; !meetLink && attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const again = await (await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(DEFAULT_CALENDAR_ID)}/events/${encodeURIComponent(data.id)}?conferenceDataVersion=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    )).json().catch(() => ({}));
    meetLink = again.hangoutLink ||
      (Array.isArray(again.conferenceData?.entryPoints)
        ? again.conferenceData.entryPoints.find((x: Json) => x.entryPointType === "video")?.uri || ""
        : "");
  }

  {
    const patchedDescription = renderTemplate(topic.description, { name, email, phone, company, notes, meetLink });
    {
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(DEFAULT_CALENDAR_ID)}/events/${encodeURIComponent(data.id)}?sendUpdates=none`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ description: patchedDescription }),
        },
      ).catch(() => null);
    }
  }

  return {
    eventId: data.id,
    meetLink,
    htmlLink: data.htmlLink,
    emailConfirmation: true,
    emailReminderMinutes: 2,
  };
}

Deno.serve(async (req) => {
  const origin = getAllowedOrigin(req);
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    if (!origin) return new Response("Forbidden", { status: 403, headers });
    return new Response("ok", { headers });
  }

  if (!origin) return jsonResponse({ error: "Invalid origin" }, 403, headers);

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/+/, "");

    if (req.method === "GET" && path.endsWith("availability")) {
      return jsonResponse(await getAvailability(), 200, headers);
    }

    if (req.method === "POST" && path.endsWith("create")) {
      const ip = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
      if (!allowBookingAttempt(ip)) return jsonResponse({ error: "Please try again later." }, 429, headers);
      const payload = await req.json().catch(() => ({}));
      const challengeSecret = Deno.env.get("BOOK_CALL_EARLV_TURNSTILE_SECRET") || "";
      if (!challengeSecret) return jsonResponse({ error: "Booking temporarily unavailable." }, 503, headers);
      if (!await verifyTurnstile(payload.turnstileToken, challengeSecret, ip)) {
        return jsonResponse({ error: "Please complete the verification and try again." }, 400, headers);
      }
      // Honeypot: real visitors never see this field, so a value means a bot.
      if (typeof payload.website === "string" && payload.website.trim()) {
        return jsonResponse({ error: "Invalid submission." }, 400, headers);
      }
      return jsonResponse(await createBooking(payload), 200, headers);
    }

    return jsonResponse({ error: "Not found" }, 404, headers);
  } catch (err) {
    return jsonResponse({ error: String(err instanceof Error ? err.message : err) }, 400, headers);
  }
});
