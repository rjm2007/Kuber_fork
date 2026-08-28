/** Instantly campaign_schedule.schedules[].timezone allowed enum (API v2). */
export const INSTANTLY_ALLOWED_TIMEZONES = new Set([
  "Etc/GMT+12", "Etc/GMT+11", "Etc/GMT+10",
  "America/Anchorage", "America/Dawson", "America/Creston", "America/Chihuahua",
  "America/Boise", "America/Belize", "America/Chicago", "America/Bahia_Banderas",
  "America/Regina", "America/Bogota", "America/Detroit", "America/Indiana/Marengo",
  "America/Caracas", "America/Asuncion", "America/Glace_Bay", "America/Campo_Grande",
  "America/Anguilla", "America/Santiago", "America/St_Johns", "America/Sao_Paulo",
  "America/Argentina/La_Rioja", "America/Araguaina", "America/Godthab",
  "America/Montevideo", "America/Bahia", "America/Noronha", "America/Scoresbysund",
  "Atlantic/Cape_Verde", "Africa/Casablanca", "America/Danmarkshavn",
  "Europe/Isle_of_Man", "Atlantic/Canary", "Africa/Abidjan", "Arctic/Longyearbyen",
  "Europe/Belgrade", "Africa/Ceuta", "Europe/Sarajevo", "Africa/Algiers",
  "Africa/Windhoek", "Asia/Nicosia", "Asia/Beirut", "Africa/Cairo",
  "Asia/Damascus", "Europe/Bucharest", "Africa/Blantyre", "Europe/Helsinki",
  "Europe/Istanbul", "Asia/Jerusalem", "Africa/Tripoli", "Asia/Amman",
  "Asia/Baghdad", "Europe/Kaliningrad", "Asia/Aden", "Africa/Addis_Ababa",
  "Europe/Kirov", "Europe/Astrakhan", "Asia/Tehran", "Asia/Dubai", "Asia/Baku",
  "Indian/Mahe", "Asia/Tbilisi", "Asia/Yerevan", "Asia/Kabul",
  "Antarctica/Mawson", "Asia/Yekaterinburg", "Asia/Karachi", "Asia/Kolkata",
  "Asia/Colombo", "Asia/Kathmandu", "Antarctica/Vostok", "Asia/Dhaka",
  "Asia/Rangoon", "Antarctica/Davis", "Asia/Novokuznetsk", "Asia/Hong_Kong",
  "Asia/Krasnoyarsk", "Asia/Brunei", "Australia/Perth", "Asia/Taipei",
  "Asia/Choibalsan", "Asia/Irkutsk", "Asia/Dili", "Asia/Pyongyang",
  "Australia/Adelaide", "Australia/Darwin", "Australia/Brisbane",
  "Australia/Melbourne", "Antarctica/DumontDUrville", "Australia/Currie",
  "Asia/Chita", "Antarctica/Macquarie", "Asia/Sakhalin", "Pacific/Auckland",
  "Etc/GMT-12", "Pacific/Fiji", "Asia/Anadyr", "Asia/Kamchatka", "Etc/GMT-13",
  "Pacific/Apia",
]);

/** Common IANA zones we use that Instantly does not accept verbatim. */
const INSTANTLY_TIMEZONE_ALIASES: Record<string, string> = {
  // UTC+0. Belgrade is UTC+1 — an hour out, and it observes DST while UTC does
  // not, so the error was one hour in winter and two in summer.
  "UTC": "Africa/Abidjan",
  "Etc/UTC": "Africa/Abidjan",
  "Africa/Nairobi": "Africa/Addis_Ababa",
  "Africa/Lagos": "Africa/Algiers",
  "Africa/Johannesburg": "Africa/Blantyre",
  // Isle of Man is a link to Europe/London — same offset, same DST rules, exact.
  // This was Europe/Belgrade (CET), putting every UK send an hour late: a 10:00
  // window opened at 09:00 London time. 132 UK leads on the client's campaigns.
  "Europe/London": "Europe/Isle_of_Man",
  // Berlin is CET; Bucharest is EET, an hour ahead. Belgrade is the CET member
  // of Instantly's enum. Affects the German and Dutch buckets (~84 leads).
  "Europe/Berlin": "Europe/Belgrade",
  "America/New_York": "America/Detroit",
  "America/Los_Angeles": "America/Boise",
  "America/Mexico_City": "America/Bahia_Banderas",
  "Asia/Singapore": "Asia/Hong_Kong",
  "Asia/Bangkok": "Asia/Rangoon",
  "Asia/Tokyo": "Asia/Pyongyang",
  "Australia/Sydney": "Australia/Melbourne",
};

function utcOffsetMinutes(timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const label = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const match = label.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!match) return null;
    const sign = match[1] === "+" ? 1 : -1;
    const hours = Number(match[2]);
    const mins = Number(match[3] ?? "0");
    return sign * (hours * 60 + mins);
  } catch {
    return null;
  }
}

/** Map any IANA timezone to an Instantly-accepted schedule timezone. */
export function toInstantlyTimezone(timeZone: string): string {
  const tz = timeZone.trim();
  if (INSTANTLY_ALLOWED_TIMEZONES.has(tz)) return tz;

  const alias = INSTANTLY_TIMEZONE_ALIASES[tz];
  if (alias && INSTANTLY_ALLOWED_TIMEZONES.has(alias)) return alias;

  const targetOffset = utcOffsetMinutes(tz);
  if (targetOffset !== null) {
    for (const allowed of INSTANTLY_ALLOWED_TIMEZONES) {
      if (utcOffsetMinutes(allowed) === targetOffset) return allowed;
    }
  }

  return "Asia/Kolkata";
}
