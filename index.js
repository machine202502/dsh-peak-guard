/**
 * Host half of dsh-peak-guard.
 *
 * Watches the DeepSeek peak tariff and, for every Session the user switched on,
 * steers a short notice into the chat: once when the peak starts (only while
 * the Session is actually working) and once when it ends (always, which wakes a
 * sleeping Session). Nothing is ever cancelled on the agent's behalf.
 *
 * The peak schedule is read from the dsh-pricing bridge, which already fetches
 * and validates the official page; `fallbackPeak` covers the case where that
 * plugin is off.
 *
 * @module dsh-peak-guard
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-peak-guard';

/** Live agents are the only thing this plugin talks to. */
export const inject = ['agents'];

const STATE_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'dsh-peak-guard');
const STATE_FILE = join(STATE_DIR, 'sessions.json');
const SETTINGS_FILE = join(STATE_DIR, 'settings.json');
const LOG_FILE = join(STATE_DIR, 'plugin.log');

/** Language choices offered by the settings form; `auto` follows the app locale. */
const LANGUAGES = ['ru', 'en', 'zh', 'auto'];
const DEFAULT_SETTINGS = { language: 'ru' };

/**
 * Source kind stamped on every message. `user` is the one kind the chat renders
 * as a normal message bubble; any other kind is shown as a dim context insertion,
 * which the user never sees in the transcript.
 */
const SOURCE = { kind: 'user' };

const DEFAULTS = {
  bridgePort: 49238,
  pricesUrl: 'http://127.0.0.1:49237/state',
  language: 'ru',
  /** Forces a schedule instead of asking the bridge; `debugWindows` wins over both. */
  debugWindows: null,
  debugTz: null,
  fallbackPeak: {
    tz: 'UTC',
    days: [1, 2, 3, 4, 5],
    windows: [
      { from: '01:00', to: '04:00' },
      { from: '06:00', to: '10:00' },
    ],
    holidays: [],
  },
};

const TEXT = {
  ru: {
    start: '⏳ Пиковый тариф, до {end} ({left}).\n' +
      'Приостановь то, что можно продолжить позже; доведи до конца только то, что почти готово. ' +
      'Коротко скажи, на чём остановились.\n' +
      'В {end} вернусь к работе сам.',
    late: '⏳ Идёт пиковый тариф, до {end} (осталось {left}).\n' +
      'Дальше — по возможности короче: не начинай длинные шаги, доведи текущее.\n' +
      'В {end} вернусь к работе сам.',
    resume: '▶️ Пик закончился, тариф снова половинный. Продолжи то, что приостановил.',
    lessMinute: 'меньше минуты',
  },
  en: {
    start: '⏳ Peak tariff, until {end} ({left}).\n' +
      'Pause what can wait; finish only what is nearly done. Briefly say where you stopped.\n' +
      'I will resume work at {end} on my own.',
    late: '⏳ The peak tariff is running, until {end} ({left} left).\n' +
      'Keep it short from here: no long steps, finish what you started.\n' +
      'I will resume work at {end} on my own.',
    resume: '▶️ The peak ended; the tariff is half price again. Continue what you paused.',
    lessMinute: 'less than a minute',
  },
  zh: {
    start: '⏳ 高峰时段，直到 {end}（还剩 {left}）。\n' +
      '能往后推的先暂停，只把快做完的收尾。简单说明停在哪里。\n' +
      '{end} 我会自动回来继续。',
    late: '⏳ 正在高峰时段，直到 {end}（还剩 {left}）。\n' +
      '接下来尽量简短：不要开始长步骤，把手头的做完。\n' +
      '{end} 我会自动回来继续。',
    resume: '▶️ 高峰结束了，价格恢复半价。继续刚才暂停的工作。',
    lessMinute: '不到一分钟',
  },
};

/** Read a JSON file, returning null instead of throwing on a missing or broken one. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write JSON through a temporary file so a crash never leaves half a file. */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

/** Append one diagnostic line; logging never breaks the plugin. */
function log(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
  } catch {
    /* logging must never break activation */
  }
}

const toMinutes = (hm) => {
  const [hour, minute] = String(hm).split(':').map(Number);
  return hour * 60 + minute;
};

/** Wall-clock parts of an instant in one time zone. */
function tzParts(zone, ms) {
  const out = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const part of formatter.formatToParts(new Date(ms))) out[part.type] = part.value;
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[out.weekday] ?? 1;
  return {
    weekday,
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    date: `${out.year}-${out.month}-${out.day}`,
  };
}

/** Offset of a zone from UTC at one instant, in milliseconds. */
function tzOffset(zone, ms) {
  const parts = tzParts(zone, ms);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - ms;
}

/** The absolute instant of a wall-clock time in one zone. */
function instantOfWall(zone, year, month, day, hour, minute) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = naive - tzOffset(zone, naive);
  return naive - tzOffset(zone, first);
}

/** Whether the provider's peak schedule covers one instant. */
function peakAt(schedule, ms) {
  if (schedule === null || !Array.isArray(schedule.windows) || schedule.windows.length === 0) return null;
  const zone = schedule.tz || 'UTC';
  const parts = tzParts(zone, ms);
  const days = Array.isArray(schedule.days) && schedule.days.length > 0 ? schedule.days : [1, 2, 3, 4, 5];
  if (!days.includes(parts.weekday)) return false;
  if ((schedule.holidays ?? []).includes(parts.date)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return schedule.windows.some((window) => {
    const from = toMinutes(window.from);
    const to = toMinutes(window.to);
    return to > from ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  });
}

/** The next instant at which the peak state flips, and whether it flips into peak. */
function nextBoundary(schedule, now) {
  if (schedule === null || !Array.isArray(schedule.windows) || schedule.windows.length === 0) return null;
  const zone = schedule.tz || 'UTC';
  const today = tzParts(zone, now);
  const candidates = [];
  for (let shift = -1; shift <= 3; shift += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + shift));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    for (const window of schedule.windows) {
      const [fromHour, fromMinute] = String(window.from).split(':').map(Number);
      const [toHour, toMinute] = String(window.to).split(':').map(Number);
      const wraps = toMinutes(window.to) <= toMinutes(window.from);
      candidates.push(instantOfWall(zone, year, month, day, fromHour, fromMinute));
      candidates.push(instantOfWall(zone, year, month, day + (wraps ? 1 : 0), toHour, toMinute));
    }
  }
  const current = peakAt(schedule, now);
  const future = candidates.filter((at) => at > now + 500).sort((left, right) => left - right);
  for (const at of future) {
    const state = peakAt(schedule, at + 1000);
    if (state !== current) return { at, toPeak: state === true };
  }
  return null;
}

/** "3 ч 20 мин" / "3 h 20 min" / "3 小时 20 分钟". */
function duration(ms, language) {
  const strings = TEXT[language] ?? TEXT.ru;
  if (!Number.isFinite(ms) || ms <= 0) return strings.lessMinute;
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return strings.lessMinute;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (language === 'en') {
    if (hours === 0) return `${rest} min`;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  if (language === 'zh') {
    if (hours === 0) return `${rest} 分钟`;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
  }
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** Local wall-clock time of an instant, e.g. "09:00". */
function clock(ms, language) {
  const locale = language === 'en' ? 'en-US' : language === 'zh' ? 'zh-CN' : 'ru-RU';
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])));
}

/** Keep only the shapes the schedule maths can use. */
function normalizeSchedule(peak) {
  if (peak === null || typeof peak !== 'object' || !Array.isArray(peak.windows)) return null;
  const windows = peak.windows
    .filter((window) => /^\d{2}:\d{2}$/u.test(String(window?.from)) && /^\d{2}:\d{2}$/u.test(String(window?.to)))
    // A window whose edges coincide is a typo, not a 24-hour peak: it would
    // otherwise match every minute of the day.
    .filter((window) => String(window.from) !== String(window.to))
    .map((window) => ({ from: String(window.from), to: String(window.to) }));
  if (windows.length === 0) return null;
  return {
    tz: typeof peak.tz === 'string' && peak.tz !== '' ? peak.tz : 'UTC',
    days: Array.isArray(peak.days) && peak.days.length > 0 ? peak.days.map(Number) : [1, 2, 3, 4, 5],
    windows,
    holidays: Array.isArray(peak.holidays) ? peak.holidays.map(String) : [],
  };
}

/**
 * Activate the host half: resolve the schedule, catch up a resume that was
 * missed while the app was closed, arm the boundary timer, and serve the chip.
 *
 * @param ctx - plugin context; disposal clears the timer and closes the bridge.
 * @param config - `bridgePort`, `pricesUrl`, `language`, `debugWindows`, `debugTz`, `fallbackPeak`.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };

  /** Stored language choice, created with the `ru` default on first activation. */
  const loadSettings = () => {
    const stored = readJson(SETTINGS_FILE);
    const language = LANGUAGES.includes(stored?.language) ? stored.language : (LANGUAGES.includes(cfg.language) ? cfg.language : DEFAULT_SETTINGS.language);
    return { language };
  };
  const saveSettings = (input) => {
    const language = LANGUAGES.includes(input?.language) ? input.language : DEFAULT_SETTINGS.language;
    const next = { language };
    writeJson(SETTINGS_FILE, next);
    return next;
  };
  let settings = loadSettings();
  writeJson(SETTINGS_FILE, settings);

  /** Resolved language of the interface and of the injected texts. */
  const language = () => (settings.language === 'en' ? 'en' : settings.language === 'zh' ? 'zh' : 'ru');
  const strings = () => TEXT[language()];
  const port = Number(cfg.bridgePort ?? 49238);

  const state = readJson(STATE_FILE);
  const sessions = state !== null && typeof state === 'object' && !Array.isArray(state) ? state : {};

  let schedule = normalizeSchedule(cfg.debugWindows === null ? cfg.fallbackPeak : { ...cfg.fallbackPeak, windows: cfg.debugWindows, tz: cfg.debugTz ?? cfg.fallbackPeak?.tz ?? 'UTC' });
  let source = cfg.debugWindows === null ? 'fallback' : 'debug';
  let timer = null;

  const save = () => writeJson(STATE_FILE, sessions);

  /** Live agent of one Session, or null when the Session is not loaded. */
  const agentOf = (sessionId) => {
    try {
      return ctx.agents.get(sessionId) ?? null;
    } catch {
      return null;
    }
  };

  /** Steer one text into a Session. Returns false when the Session has no live agent. */
  const steer = (sessionId, text) => {
    const agent = agentOf(sessionId);
    if (agent === null) return false;
    agent.steer({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: SOURCE,
    });
    return true;
  };

  /** Every enabled Session id whose agent is loaded. */
  const enabledIds = () => Object.keys(sessions).filter((id) => sessions[id]?.enabled === true);

  /** Drop the notice for one Session and remember the resume it owes. */
  const announceStart = (sessionId, now, end, late) => {
    const agent = agentOf(sessionId);
    if (agent === null || agent.status !== 'running') return false;
    const template = late ? strings().late : strings().start;
    const ok = steer(sessionId, fill(template, {
      end: clock(end, language()),
      left: duration(end - now, language()),
    }));
    if (!ok) return false;
    sessions[sessionId].notified = true;
    sessions[sessionId].resumeAt = end;
    sessions[sessionId].resumeDelivered = false;
    save();
    log(`notified ${sessionId} late=${late} until=${new Date(end).toISOString()}`);
    return true;
  };

  const announceResume = (sessionId) => {
    const ok = steer(sessionId, strings().resume);
    sessions[sessionId].notified = false;
    sessions[sessionId].resumeDelivered = true;
    save();
    log(`resumed ${sessionId} ok=${ok}`);
    return ok;
  };

  /** Peak just started (or we woke up inside one): notify every working Session once. */
  const onPeakStart = (now) => {
    const boundary = nextBoundary(schedule, now);
    const end = boundary === null ? now : boundary.at;
    let touched = false;
    for (const sessionId of enabledIds()) {
      const entry = sessions[sessionId];
      if (entry.notified === true) continue;
      if (announceStart(sessionId, now, end, false)) touched = true;
    }
    return touched;
  };

  /** Peak just ended: resume every Session that was told to wind down. */
  const onPeakEnd = (now) => {
    for (const sessionId of enabledIds()) {
      const entry = sessions[sessionId];
      if (entry.notified !== true) continue;
      announceResume(sessionId);
      void now;
    }
  };

  /** Re-read the schedule from the prices bridge, falling back to the config copy. */
  const refresh = async () => {
    if (cfg.debugWindows !== null) {
      schedule = normalizeSchedule({ ...cfg.fallbackPeak, windows: cfg.debugWindows, tz: cfg.debugTz ?? cfg.fallbackPeak?.tz ?? 'UTC' });
      source = 'debug';
      return;
    }
    try {
      const response = await fetch(cfg.pricesUrl, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const next = normalizeSchedule(payload?.peak);
      if (next === null) throw new Error('no peak schedule in the payload');
      schedule = next;
      source = 'prices';
    } catch (error) {
      schedule = normalizeSchedule(cfg.fallbackPeak);
      source = 'fallback';
      void error;
    }
  };

  const arm = () => {
    if (timer !== null) clearTimeout(timer);
    const boundary = nextBoundary(schedule, Date.now());
    if (boundary === null) return;
    const delay = Math.max(1000, boundary.at - Date.now() + 1000);
    timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
  };

  /** Boundary handler: figure out which side we landed on and act. */
  const tick = async () => {
    await refresh();
    const now = Date.now();
    if (peakAt(schedule, now) === true) onPeakStart(now);
    else onPeakEnd(now);
    arm();
  };

  /** A Session woke up: hand it the notice it missed, at most once per peak. */
  const onAgentStatus = ({ agent, status }) => {
    if (status !== 'running' || agent === undefined || agent === null) return;
    const sessionId = String(agent.id);
    const entry = sessions[sessionId];
    if (entry === undefined || entry.enabled !== true || entry.notified === true) return;
    const now = Date.now();
    if (peakAt(schedule, now) !== true) return;
    const boundary = nextBoundary(schedule, now);
    if (boundary === null) return;
    announceStart(sessionId, now, boundary.at, true);
  };

  ctx.on('agent/status', onAgentStatus);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'cache-control': 'no-store',
    };
    const json = (code, body) => {
      response.writeHead(code, { ...cors, 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors).end();
      return;
    }
    const path = url.pathname.replace(/\/+$/u, '');
    const snapshot = (sessionId) => {
      const now = Date.now();
      const peak = peakAt(schedule, now);
      const boundary = nextBoundary(schedule, now);
      const entry = sessions[sessionId] ?? null;
      return {
        session: sessionId,
        enabled: entry?.enabled === true,
        notified: entry?.notified === true,
        peak,
        boundaryAt: boundary === null ? null : boundary.at,
        boundaryToPeak: boundary === null ? null : boundary.toPeak,
        windows: schedule?.windows ?? [],
        tz: schedule?.tz ?? 'UTC',
        days: schedule?.days ?? [],
        source,
        language: language(),
        settings,
      };
    };
    if (path === '/health') return json(200, { ok: true, port });
    if (path === '/settings' && request.method === 'GET') {
      return json(200, { values: settings, defaults: DEFAULT_SETTINGS, options: LANGUAGES });
    }
    if (path === '/settings' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      try {
        const parsed = JSON.parse(body || '{}');
        settings = saveSettings(parsed);
        log(`settings saved: language=${settings.language}`);
        return json(200, { values: settings, defaults: DEFAULT_SETTINGS, options: LANGUAGES });
      } catch (error) {
        return json(400, { error: String(error?.message ?? error) });
      }
    }
    if (path === '/state' && request.method === 'GET') {
      return json(200, snapshot(url.searchParams.get('session') ?? ''));
    }
    if (path === '/toggle' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      try {
        const parsed = JSON.parse(body || '{}');
        const sessionId = String(parsed.session ?? '');
        if (sessionId === '') return json(400, { error: 'session is required' });
        const entry = sessions[sessionId] ?? { enabled: false };
        entry.enabled = entry.enabled !== true;
        if (entry.enabled !== true) {
          entry.notified = false;
          entry.resumeAt = null;
          entry.resumeDelivered = true;
        } else {
          entry.notified = false;
          entry.resumeDelivered = true;
          entry.resumeAt = null;
        }
        sessions[sessionId] = entry;
        save();
        log(`toggle ${sessionId} enabled=${entry.enabled}`);
        return json(200, snapshot(sessionId));
      } catch (error) {
        return json(400, { error: String(error?.message ?? error) });
      }
    }
    return json(404, { error: 'not found' });
  });
  server.on('error', (error) => log(`bridge error: ${String(error?.message ?? error)}`));
  server.listen(port, '127.0.0.1', () => log(`bridge on 127.0.0.1:${port} source=${source}`));

  void (async () => {
    await refresh();
    const now = Date.now();
    // Catch up a resume the app was closed for, unless a newer peak already owns the Session.
    for (const sessionId of enabledIds()) {
      const entry = sessions[sessionId];
      if (entry.resumeDelivered === true || typeof entry.resumeAt !== 'number') continue;
      if (now < entry.resumeAt) continue;
      if (peakAt(schedule, now) === true) {
        entry.resumeDelivered = true;
        entry.notified = false;
        save();
        log(`dropped stale resume ${sessionId}`);
        continue;
      }
      announceResume(sessionId);
    }
    if (peakAt(schedule, now) === true) onPeakStart(now);
    arm();
  })();

  ctx.on('dispose', () => {
    if (timer !== null) clearTimeout(timer);
    server.close();
    log('disposed');
  });
}
