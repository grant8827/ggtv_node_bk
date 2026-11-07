// Repeating breaks. A break can play once, or repeat every day, on chosen weekdays, or on the same
// date each month, and on each of those days it can repeat every N minutes until a time of day.
// Times are wall-clock times in the studio's time zone, so a 09:00 break stays at 09:00 across
// daylight-saving changes even though the server runs in UTC.

export const FREQUENCIES = ["once", "daily", "weekly", "monthly"];
const DAY_MS = 86400000;

const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }));
  }
  return formatters.get(timeZone);
}

export function validTimeZone(timeZone) {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

// The wall-clock parts of an instant in a time zone.
function wallClock(ms, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

function offsetAt(ms, timeZone) {
  const wall = wallClock(ms, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(ms / 1000) * 1000;
}

// The instant a wall-clock time happens in a time zone. A time skipped by a clock change moves
// forward by the change; a time that happens twice uses the first.
function zonedToUtc(year, month, day, minuteOfDay, timeZone) {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return Math.min(first, second);
}

const toMinutes = (hhmm) => {
  const [hours, mins] = hhmm.split(":").map(Number);
  return hours * 60 + mins;
};

// When each repeat of a break starts and ends, for occurrences that overlap [fromMs, toMs).
export function occurrences(entry, fromMs, toMs, limit = 5000) {
  const startMs = Date.parse(entry.start);
  const lengthMs = Date.parse(entry.end) - startMs;
  const repeat = entry.repeat;
  if (!repeat || repeat.frequency === "once") {
    return startMs < toMs && startMs + lengthMs > fromMs ? [{ start: entry.start, end: entry.end }] : [];
  }

  const { timeZone } = repeat;
  const first = wallClock(startMs, timeZone);
  const firstMinute = first.hour * 60 + first.minute;
  const lastMinute = repeat.everyMinutes > 0 ? Math.max(firstMinute, toMinutes(repeat.untilTime)) : firstMinute;
  const step = repeat.everyMinutes > 0 ? repeat.everyMinutes : 1440;
  const firstDay = Date.UTC(first.year, first.month - 1, first.day);
  const lastDay = repeat.endDate ? Date.parse(`${repeat.endDate}T00:00:00Z`) : Infinity;
  // Calendar days in the zone, from a day before the window (a break can run past midnight).
  const from = wallClock(fromMs - lengthMs, timeZone);
  const to = wallClock(toMs, timeZone);
  let day = Math.max(firstDay, Date.UTC(from.year, from.month - 1, from.day) - DAY_MS);
  const endDay = Math.min(lastDay, Date.UTC(to.year, to.month - 1, to.day));

  const result = [];
  for (; day <= endDay && result.length < limit; day += DAY_MS) {
    const date = new Date(day);
    const matches = repeat.frequency === "daily"
      || (repeat.frequency === "weekly" && repeat.weekdays.includes(date.getUTCDay()))
      // A break on the 29th-31st plays on the last day of shorter months.
      || (repeat.frequency === "monthly" && date.getUTCDate() === Math.min(first.day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
    if (!matches) continue;
    for (let minute = firstMinute; minute <= lastMinute && result.length < limit; minute += step) {
      const start = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), minute, timeZone) + (startMs % 60000);
      if (start < startMs || start >= toMs || start + lengthMs <= fromMs) continue;
      result.push({ start: new Date(start).toISOString(), end: new Date(start + lengthMs).toISOString() });
    }
  }
  return result;
}

// The first pair of overlapping occurrences of two breaks within the window, if any.
export function firstOverlap(a, b, fromMs, toMs) {
  const left = occurrences(a, fromMs, toMs);
  const right = occurrences(b, fromMs, toMs);
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i].start < right[j].end && right[j].start < left[i].end) return left[i];
    if (left[i].end <= right[j].end) i += 1;
    else j += 1;
  }
  return null;
}

// Whether a repeating break has no more occurrences after `nowMs`.
export function seriesFinished(entry, nowMs) {
  if (!entry.repeat || entry.repeat.frequency === "once") return Date.parse(entry.end) <= nowMs;
  if (!entry.repeat.endDate) return false;
  const lastDay = Date.parse(`${entry.repeat.endDate}T00:00:00Z`) + 2 * DAY_MS;
  return lastDay < nowMs || !occurrences(entry, nowMs, lastDay, 1).length;
}
