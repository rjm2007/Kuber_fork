// Synthetic caller id for the service-role bearer (see lib/auth/api-auth).
// Deliberately NOT a row in `profiles`, so anything writing it to a column with
// an FK to profiles must map it to null first — otherwise the insert fails.
// Lives here rather than in api-auth so plain services can check it without
// pulling in the whole auth/next-server stack.
export const SERVICE_ROLE_USER_ID = "00000000-0000-0000-0000-000000000000";

// Fixed company UUID for "Kuber Internal (Dev)" (see 2026_07_28_multi_tenant_companies.sql).
// provider_keys are shared across all companies (one Apollo/Firecrawl/etc.
// balance for everyone), so anything that spends real provider credits must
// never run against this company's data — it's dev/test only.
export const DEV_COMPANY_ID = "00000000-0000-0000-0000-00000000000a";

// Widened 2026-08-13 after measuring the real cost of the old list against
// Apollo's free people-search (docs/apollo-filter-measurement.md). The previous
// ten titles returned a TOTAL pool of 46 people for "molding"/USA — the client
// asked for 25 from that, while already owning 566 US leads, and got 8.
//
// Widening the list took the same search to 205 (+346%) with relevance intact:
// Supply Chain Manager @ National Molding, Owner-CEO @ Molding Concepts.
// Removing the title filter altogether reached 813 but collapsed quality —
// Group HR Executive, CFO, and people whose title is literally "Molding" at
// Thermo Fisher — so the filter stays, it is only broader.
export const APOLLO_TITLES = [
  // Original ten
  "purchase manager",
  "procurement manager",
  "plant manager",
  "managing director",
  "production manager",
  "procurement head",
  "purchase officer",
  "technical manager",
  "proprietor",
  "founder",
  // Buying roles the old list missed entirely
  "buyer",
  "purchasing manager",
  "head of purchasing",
  "head of procurement",
  "sourcing manager",
  "supply chain manager",
  "materials manager",
  "category manager",
  // Trade roles — notable omissions for a business selling to exporters
  "import manager",
  "export manager",
  // Decision makers at smaller firms, where one person signs everything
  "general manager",
  "operations manager",
  "owner",
  "director",
  "ceo",
  "partner",
];

export const APOLLO_SENIORITIES = [
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
];

export const ALLOWED_KEYWORDS = ["plastics", "polymer", "moulding", "packaging"] as const;
export type AllowedKeyword = (typeof ALLOWED_KEYWORDS)[number];

// `query` is the term actually sent to Apollo's `q_keywords` — it must be
// short and plain (no slashes/parens/example lists). Apollo matches q_keywords
// literally against its own index; the descriptive `label` text (live-tested
// 2026-07-14) returns 0 total_entries for 26/28 of these segments verbatim,
// while short single/two-word terms return real volume. Picked via live
// Apollo API testing against the app's actual title/seniority/employee-range
// filter stack — not guessed.
export type IndustryKeyword = { label: string; query: string; starred?: boolean };
export type IndustryKeywordCategory = { id: string; label: string; emoji: string; keywords: IndustryKeyword[] };

export const INDUSTRY_KEYWORD_CATEGORIES: IndustryKeywordCategory[] = [
  {
    id: "pet-bottles",
    label: "PET Bottles & Closures",
    emoji: "🧴",
    keywords: [
      { label: "Beverage Bottles (Water/Juice/CSD)", query: "bottling", starred: true },
      { label: "Cosmetic & Personal Care Bottles", query: "cosmetics", starred: true },
      { label: "Pharma & Agrochemical Bottles", query: "pharmaceuticals" },
      { label: "Caps & Closures", query: "closures" },
    ],
  },
  {
    id: "blown-film",
    label: "Blown Film & Flexible Packaging",
    emoji: "📦",
    keywords: [
      { label: "Packaging Films (Pouches/Lamination)", query: "flexible packaging", starred: true },
      { label: "Stretch & Cling Films", query: "flexible packaging" },
      { label: "Agricultural Films (Mulch/Silage/Greenhouse)", query: "agriculture" },
      { label: "Milk Pouch & Food Films", query: "dairy" },
      { label: "Courier Bags & Industrial Bags", query: "shipping" },
    ],
  },
  {
    id: "blow-molding",
    label: "Blow Molding",
    emoji: "🪣",
    keywords: [
      { label: "Industrial Drums & IBCs", query: "containers" },
      { label: "Water Tanks & Storage", query: "tanks" },
      { label: "Automotive Blow Molded Parts", query: "automotive" },
    ],
  },
  {
    id: "injection-molding",
    label: "Injection Molding",
    emoji: "🔧",
    keywords: [
      { label: "Household Goods & Furniture", query: "furniture", starred: true },
      { label: "Toy Manufacturers", query: "toys" },
      { label: "Industrial Parts (Crates/Pallets)", query: "pallets" },
    ],
  },
  {
    id: "roto-molding",
    label: "Roto Molding",
    emoji: "🔄",
    keywords: [
      { label: "Roto Molding Tanks & Equipment", query: "molding" },
    ],
  },
  {
    id: "compounders",
    label: "Compounders",
    emoji: "⚗️",
    keywords: [
      { label: "PE/PP Commodity Compounders (PE100)", query: "polymers", starred: true },
      { label: "Engineering Plastic Compounders (ABS/PC/Nylon)", query: "engineering plastics", starred: true },
      { label: "Recycled Plastic Compounders", query: "recycling" },
    ],
  },
  {
    id: "recyclers",
    label: "Recyclers",
    emoji: "♻️",
    keywords: [
      { label: "PE/PP Recyclers & Reclaimers", query: "recycling", starred: true },
      { label: "PET Recyclers & rPET Processors", query: "recycling" },
    ],
  },
  {
    id: "specialty",
    label: "Specialty",
    emoji: "⭐",
    keywords: [
      { label: "Mono Concentrate Users (Europe/Americas)", query: "masterbatch", starred: true },
      { label: "Black Masterbatch Buyers (General)", query: "masterbatch" },
      { label: "Pipe Manufacturers (HDPE/PPR/PVC)", query: "pipe", starred: true },
      { label: "Masterbatch Distributors", query: "masterbatch" },
      { label: "Masterbatch Manufacturers", query: "masterbatch" },
      { label: "Solar Film Manufacturers", query: "solar" },
      { label: "Textile & Fiber Manufacturers", query: "textile" },
    ],
  },
];

/** Resolve a UI keyword label (or a free-typed custom keyword) to the term actually sent to Apollo's q_keywords. */
export function resolveApolloKeyword(label: string): string {
  for (const category of INDUSTRY_KEYWORD_CATEGORIES) {
    const match = category.keywords.find((k) => k.label === label);
    if (match) return match.query;
  }
  return label;
}

export type LocationCategory = { id: string; label: string; countries: string[] };

export const LOCATION_CATEGORIES: LocationCategory[] = [
  {
    id: "south-asia",
    label: "South Asia",
    countries: ["India", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal", "Afghanistan", "Bhutan", "Maldives"],
  },
  {
    id: "southeast-asia",
    label: "Southeast Asia",
    countries: ["Vietnam", "Thailand", "Indonesia", "Malaysia", "Philippines", "Singapore", "Myanmar", "Cambodia", "Laos", "Brunei", "Timor-Leste"],
  },
  {
    id: "east-asia",
    label: "East Asia",
    countries: ["China", "Japan", "South Korea", "Taiwan", "Hong Kong", "Mongolia"],
  },
  {
    id: "central-asia",
    label: "Central Asia",
    countries: ["Kazakhstan", "Uzbekistan", "Turkmenistan", "Kyrgyzstan", "Tajikistan", "Armenia", "Azerbaijan", "Georgia"],
  },
  {
    id: "middle-east",
    label: "Middle East",
    countries: ["UAE", "Saudi Arabia", "Turkey", "Iran", "Iraq", "Israel", "Jordan", "Kuwait", "Qatar", "Oman", "Bahrain", "Lebanon", "Syria", "Yemen", "Palestine"],
  },
  {
    id: "western-europe",
    label: "Western Europe",
    countries: ["Germany", "France", "United Kingdom", "Italy", "Spain", "Netherlands", "Belgium", "Switzerland", "Austria", "Portugal", "Sweden", "Norway", "Denmark", "Finland", "Ireland", "Greece", "Luxembourg", "Cyprus", "Malta", "Iceland", "Monaco", "Guernsey", "Jersey"],
  },
  {
    id: "eastern-europe",
    label: "Eastern Europe",
    countries: ["Poland", "Czech Republic", "Romania", "Hungary", "Ukraine", "Russia", "Bulgaria", "Slovakia", "Croatia", "Serbia", "Belarus", "Slovenia", "Estonia", "Latvia", "Lithuania", "Albania", "Moldova", "Bosnia and Herzegovina", "North Macedonia", "Montenegro"],
  },
  {
    id: "north-america",
    label: "North America",
    countries: ["United States", "Canada", "Mexico"],
  },
  {
    id: "central-america-caribbean",
    label: "Central America & Caribbean",
    countries: ["Guatemala", "Honduras", "El Salvador", "Nicaragua", "Costa Rica", "Panama", "Cuba", "Dominican Republic", "Jamaica", "Haiti", "Trinidad and Tobago", "Belize", "Puerto Rico", "Aruba", "Bahamas", "Barbados"],
  },
  {
    id: "south-america",
    label: "South America",
    countries: ["Brazil", "Argentina", "Colombia", "Chile", "Peru", "Venezuela", "Ecuador", "Bolivia", "Paraguay", "Uruguay", "Guyana", "Suriname"],
  },
  {
    id: "north-africa",
    label: "North Africa",
    countries: ["Egypt", "Morocco", "Algeria", "Tunisia", "Libya", "Sudan"],
  },
  {
    id: "west-africa",
    label: "West Africa",
    countries: ["Nigeria", "Ghana", "Senegal", "Ivory Coast", "Cameroon", "Mali", "Burkina Faso", "Niger", "Guinea", "Benin", "Togo", "Sierra Leone", "Liberia", "Gambia", "Cape Verde"],
  },
  {
    id: "east-africa",
    label: "East Africa",
    countries: ["Kenya", "Ethiopia", "Tanzania", "Uganda", "Rwanda", "Somalia", "Mozambique", "Madagascar", "Zambia", "Zimbabwe", "Malawi", "Botswana", "Namibia"],
  },
  {
    id: "southern-africa",
    label: "Southern Africa",
    countries: ["South Africa", "Angola", "Lesotho", "Eswatini"],
  },
  {
    id: "oceania",
    label: "Oceania",
    countries: ["Australia", "New Zealand", "Papua New Guinea", "Fiji", "Solomon Islands", "Vanuatu", "Samoa", "Tonga"],
  },
];

// Widened 2026-08-13. The old ["10,200","200,1000"] excluded every company
// under 10 staff and over 1,000 — 44% of the market for this keyword set, and
// both ends matter here: small trading houses and the large manufacturers
// worth winning. Widening took "molding"/USA from 46 to 84 (+83%) with the
// same calibre of company (Polyoak Packaging, Termatec Molding).
//
// The "min,max" format is CONFIRMED honoured, not assumed: sending ["7,9"]
// collapsed a 7,032-result search to 190, and ["1,100000"] restored it to
// 6,855, which is only possible if Apollo parses the numbers.
export const EMPLOYEE_RANGES = ["1,10", "11,50", "51,200", "201,1000", "1001,10000"];

export const CONTACT_EMAIL_STATUSES = ["verified", "likely to engage"];

// ── Company Lookup ──────────────────────────────────────────────────────────

/** Contacts a single Company Lookup may reveal. This is the ONLY spend ceiling
 *  on the reveal step, so it is enforced in the validator (server-side), not
 *  just by disabling checkboxes. */
export const COMPANY_LOOKUP_MAX_CONTACTS = 5;

/** Apollo pages one lookup may buy. Apollo itself allows 500; each costs a
 *  credit, and if the right company is not among 300 candidates the answer is
 *  a better filter, not a deeper page. Tune once real usage says otherwise. */
export const COMPANY_LOOKUP_MAX_PAGES = 3;

/** Title ranking for the people list. Company Lookup cannot rank on seniority
 *  — Apollo's people search does not return it — so ordering is derived from
 *  the title string. Lower index = higher in the list; anything unmatched
 *  sorts last in Apollo's own order.
 *  Matched as a lowercased substring, so "Group Managing Director" hits
 *  "managing director" before it hits "director". Order matters: the FIRST
 *  entry that appears in the title wins, so keep specific phrases above the
 *  generic words they contain. */
export const COMPANY_LOOKUP_TITLE_RANK = [
  "chief executive",
  "ceo",
  "founder",
  "co-founder",
  "managing director",
  "owner",
  "proprietor",
  "partner",
  "president",
  "chairman",
  "director",
  "vice president",
  "vp",
  "head of",
  "export",
  "import",
  "procurement",
  "purchase",
  "purchasing",
  "sourcing",
  "supply chain",
  "commercial",
  "sales",
  "business development",
  "operations",
  "plant",
  "production",
  "manager",
] as const;

/** Index of the first ranked phrase contained in `title`, or a large number
 *  when nothing matches (unranked titles sink to the bottom, keeping Apollo's
 *  own relevance order among themselves). */
export function companyLookupTitleRank(title: string | null | undefined): number {
  if (!title) return Number.MAX_SAFE_INTEGER;
  const t = title.toLowerCase();
  const i = COMPANY_LOOKUP_TITLE_RANK.findIndex((phrase) => t.includes(phrase));
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/** Maps UI dropdown label → Apollo person_locations[] value */
export const LOCATION_MAP: Record<string, string> = {
  // South Asia
  India: "India", Pakistan: "Pakistan", Bangladesh: "Bangladesh", "Sri Lanka": "Sri Lanka",
  Nepal: "Nepal", Afghanistan: "Afghanistan", Bhutan: "Bhutan", Maldives: "Maldives",
  // Southeast Asia
  Vietnam: "Vietnam", Thailand: "Thailand", Indonesia: "Indonesia", Malaysia: "Malaysia",
  Philippines: "Philippines", Singapore: "Singapore", Myanmar: "Myanmar", Cambodia: "Cambodia",
  Laos: "Laos", Brunei: "Brunei", "Timor-Leste": "Timor-Leste",
  // East Asia
  China: "China", Japan: "Japan", "South Korea": "South Korea", Taiwan: "Taiwan",
  "Hong Kong": "Hong Kong", Mongolia: "Mongolia",
  // Central Asia
  Kazakhstan: "Kazakhstan", Uzbekistan: "Uzbekistan", Turkmenistan: "Turkmenistan",
  Kyrgyzstan: "Kyrgyzstan", Tajikistan: "Tajikistan", Armenia: "Armenia",
  Azerbaijan: "Azerbaijan", Georgia: "Georgia",
  // Middle East
  UAE: "United Arab Emirates", "Saudi Arabia": "Saudi Arabia", Turkey: "Turkey",
  Iran: "Iran", Iraq: "Iraq", Israel: "Israel", Jordan: "Jordan", Kuwait: "Kuwait",
  Qatar: "Qatar", Oman: "Oman", Bahrain: "Bahrain", Lebanon: "Lebanon",
  Syria: "Syria", Yemen: "Yemen", Palestine: "Palestine",
  // Western Europe
  Germany: "Germany", France: "France", "United Kingdom": "United Kingdom", Italy: "Italy",
  Spain: "Spain", Netherlands: "Netherlands", Belgium: "Belgium", Switzerland: "Switzerland",
  Austria: "Austria", Portugal: "Portugal", Sweden: "Sweden", Norway: "Norway",
  Denmark: "Denmark", Finland: "Finland", Ireland: "Ireland", Greece: "Greece",
  Luxembourg: "Luxembourg", Cyprus: "Cyprus", Malta: "Malta", Iceland: "Iceland",
  Monaco: "Monaco", Guernsey: "Guernsey", Jersey: "Jersey",
  // Eastern Europe
  Poland: "Poland", "Czech Republic": "Czech Republic", Romania: "Romania", Hungary: "Hungary",
  Ukraine: "Ukraine", Russia: "Russia", Bulgaria: "Bulgaria", Slovakia: "Slovakia",
  Croatia: "Croatia", Serbia: "Serbia", Belarus: "Belarus", Slovenia: "Slovenia",
  Estonia: "Estonia", Latvia: "Latvia", Lithuania: "Lithuania", Albania: "Albania",
  Moldova: "Moldova", "Bosnia and Herzegovina": "Bosnia and Herzegovina",
  "North Macedonia": "North Macedonia", Montenegro: "Montenegro",
  // North America
  "United States": "United States", Canada: "Canada", Mexico: "Mexico",
  // Central America & Caribbean
  Guatemala: "Guatemala", Honduras: "Honduras", "El Salvador": "El Salvador",
  Nicaragua: "Nicaragua", "Costa Rica": "Costa Rica", Panama: "Panama", Cuba: "Cuba",
  "Dominican Republic": "Dominican Republic", Jamaica: "Jamaica", Haiti: "Haiti",
  "Trinidad and Tobago": "Trinidad and Tobago", Belize: "Belize",
  "Puerto Rico": "Puerto Rico", Aruba: "Aruba", Bahamas: "Bahamas", Barbados: "Barbados",
  // South America
  Brazil: "Brazil", Argentina: "Argentina", Colombia: "Colombia", Chile: "Chile",
  Peru: "Peru", Venezuela: "Venezuela", Ecuador: "Ecuador", Bolivia: "Bolivia",
  Paraguay: "Paraguay", Uruguay: "Uruguay", Guyana: "Guyana", Suriname: "Suriname",
  // North Africa
  Egypt: "Egypt", Morocco: "Morocco", Algeria: "Algeria", Tunisia: "Tunisia",
  Libya: "Libya", Sudan: "Sudan",
  // West Africa
  Nigeria: "Nigeria", Ghana: "Ghana", Senegal: "Senegal", "Ivory Coast": "Ivory Coast",
  Cameroon: "Cameroon", Mali: "Mali", "Burkina Faso": "Burkina Faso", Niger: "Niger",
  Guinea: "Guinea", Benin: "Benin", Togo: "Togo", "Sierra Leone": "Sierra Leone",
  Liberia: "Liberia", Gambia: "Gambia", "Cape Verde": "Cape Verde",
  // East Africa
  Kenya: "Kenya", Ethiopia: "Ethiopia", Tanzania: "Tanzania", Uganda: "Uganda",
  Rwanda: "Rwanda", Somalia: "Somalia", Mozambique: "Mozambique", Madagascar: "Madagascar",
  Zambia: "Zambia", Zimbabwe: "Zimbabwe", Malawi: "Malawi", Botswana: "Botswana",
  Namibia: "Namibia",
  // Southern Africa
  "South Africa": "South Africa", Angola: "Angola", Lesotho: "Lesotho", Eswatini: "Eswatini",
  // Oceania
  Australia: "Australia", "New Zealand": "New Zealand", "Papua New Guinea": "Papua New Guinea",
  Fiji: "Fiji", "Solomon Islands": "Solomon Islands", Vanuatu: "Vanuatu",
  Samoa: "Samoa", Tonga: "Tonga",
};

/** Default timezone per country when lead.time_zone is absent */
export const COUNTRY_TIMEZONE: Record<string, string> = {
  India: "Asia/Kolkata",
  Bangladesh: "Asia/Dhaka",
  "Sri Lanka": "Asia/Colombo",
  Pakistan: "Asia/Karachi",
  Poland: "Europe/Warsaw",
  "Czech Republic": "Europe/Prague",
  Romania: "Europe/Bucharest",
  "United Arab Emirates": "Asia/Dubai",
  "Saudi Arabia": "Asia/Riyadh",
  Turkey: "Europe/Istanbul",
  Vietnam: "Asia/Ho_Chi_Minh",
  Thailand: "Asia/Bangkok",
  Indonesia: "Asia/Jakarta",
  Malaysia: "Asia/Kuala_Lumpur",
  Egypt: "Africa/Cairo",
  Nigeria: "Africa/Lagos",
  Kenya: "Africa/Nairobi",
  Brazil: "America/Sao_Paulo",
  Mexico: "America/Mexico_City",
};

export const COUNTRY_TO_TIMEZONE: Record<string, string> = {
  ...COUNTRY_TIMEZONE,
  UAE: "Asia/Dubai",
  "United States": "America/New_York",
  USA: "America/New_York",
  "United Kingdom": "Europe/London",
  Germany: "Europe/Berlin",
  Singapore: "Asia/Singapore",
};


export type CampaignStepInput = {
  step_order: number;
  delay: number;
  delay_unit: "minutes" | "hours" | "days";
  subject: string;
  body: string;
  /** Extra guidance for this step's follow-up, on top of the campaign-wide one.
   *  Optional so callers that only care about timing (the Options tab) can keep
   *  passing steps without it — and must not blank what someone typed. */
  ai_instruction?: string | null;
  /** Text sent when this follow-up cannot be personalised — the lead has no
   *  company data, or the AI failed. Null/empty inherits the Settings default.
   *  Optional for the same reason as ai_instruction: the Options tab edits only
   *  timing and must not blank what someone typed here. */
  fallback_body?: string | null;
};

export type FollowupStepInput = {
  delay: number;
  delay_unit: "minutes" | "hours" | "days";
};

/**
 * Builds the campaign_steps rows for a new campaign given an array of follow-up
 * waits. Each entry in `followupSteps` is the wait AFTER the previous email
 * before that follow-up sends.
 *
 * Instantly's `delay`/`delay_unit` on a step is NOT "wait before this email" —
 * it's "wait before the NEXT email" (see developer.instantly.ai). So the wait
 * values are stored shifted back by one step: step N's delay holds the wait
 * before step N+1. The final step's delay is unused (there's no step after it)
 * and is left at 0/"days".
 */
export function buildDefaultCampaignSteps(followupSteps: FollowupStepInput[]): CampaignStepInput[] {
  const steps: CampaignStepInput[] = [
    {
      step_order: 1,
      delay: followupSteps[0]?.delay ?? 0,
      delay_unit: followupSteps[0]?.delay_unit ?? "days",
      subject: "{{customSubject}}",
      body: "{{customBody}}",
    },
  ];

  followupSteps.forEach((_, idx) => {
    const next = followupSteps[idx + 1];
    steps.push({
      step_order: idx + 2,
      delay: next?.delay ?? 0,
      delay_unit: next?.delay_unit ?? "days",
      subject: "", // empty = Instantly threads it as a reply in the same conversation
      body: `{{customBody${idx + 2}}}`, // per-lead variable; seeded with generic fallback at lead-push time
    });
  });

  return steps;
}

/** Read follow-up wait times from stored steps (Instantly: delay on step N = wait before step N+1). */
export function extractFollowupWaitsFromSteps(
  steps: Array<{ step_order: number; delay: number; delay_unit?: string | null }>,
): FollowupStepInput[] {
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order);
  if (sorted.length <= 1) return [];
  return sorted.slice(0, -1).map((s) => ({
    delay: s.delay ?? 0,
    delay_unit: (s.delay_unit ?? "days") as FollowupStepInput["delay_unit"],
  }));
}

/** Apply follow-up waits onto existing steps, preserving subjects/bodies. Adds or removes steps as needed. */
export function rebuildStepsWithFollowupWaits<T extends CampaignStepInput>(
  existingSteps: T[],
  followupWaits: FollowupStepInput[],
): T[] {
  const sorted = [...existingSteps].sort((a, b) => a.step_order - b.step_order);
  const defaults = buildDefaultCampaignSteps(
    followupWaits.length > 0 ? followupWaits : [{ delay: 30, delay_unit: "days" }],
  );
  return defaults.map((def) => {
    const existing = sorted.find((s) => s.step_order === def.step_order);
    if (existing) {
      return { ...existing, delay: def.delay, delay_unit: def.delay_unit };
    }
    return def as T;
  });
}

export const BATCH_COLORS = [
  { name: "violet", bg: "bg-violet-400",  ring: "ring-violet-400",  text: "text-violet-400",  pill: "bg-violet-500/15 border-violet-500/30 text-violet-400"  },
  { name: "blue",   bg: "bg-blue-400",    ring: "ring-blue-400",    text: "text-blue-400",    pill: "bg-blue-500/15 border-blue-500/30 text-blue-400"         },
  { name: "cyan",   bg: "bg-cyan-400",    ring: "ring-cyan-400",    text: "text-cyan-400",    pill: "bg-cyan-500/15 border-cyan-500/30 text-cyan-400"         },
  { name: "green",  bg: "bg-green-400",   ring: "ring-green-400",   text: "text-green-400",   pill: "bg-green-500/15 border-green-500/30 text-green-400"      },
  { name: "amber",  bg: "bg-amber-400",   ring: "ring-amber-400",   text: "text-amber-400",   pill: "bg-amber-500/15 border-amber-500/30 text-amber-400"      },
  { name: "orange", bg: "bg-orange-400",  ring: "ring-orange-400",  text: "text-orange-400",  pill: "bg-orange-500/15 border-orange-500/30 text-orange-400"   },
  { name: "pink",   bg: "bg-pink-400",    ring: "ring-pink-400",    text: "text-pink-400",    pill: "bg-pink-500/15 border-pink-500/30 text-pink-400"         },
  { name: "teal",   bg: "bg-teal-400",    ring: "ring-teal-400",    text: "text-teal-400",    pill: "bg-teal-500/15 border-teal-500/30 text-teal-400"         },
] as const;

export type BatchColorName = typeof BATCH_COLORS[number]["name"];

export function getBatchColor(name: string) {
  return BATCH_COLORS.find((c) => c.name === name) ?? BATCH_COLORS[0];
}

// ─── Reply classification maps ────────────────────────────────────────────────

// Map our temperature bucket → Instantly interest code (for syncing back via API)
export const TEMPERATURE_TO_INTEREST: Record<string, number | null> = {
  hot: 1,          // Interested
  warm: 1,         // also Interested in Instantly (no separate "warm" code)
  cold: -1,        // Not Interested
  neutral: null,   // leave as Lead
  ooo: 0,          // Out of Office
  unsubscribed: null,
};

// Map Instantly interest code → our temperature (for webhook lead_* events)
export const INTEREST_TO_TEMPERATURE: Record<number, string> = {
  1: "hot", 2: "hot", 3: "hot", 4: "hot",
  0: "ooo",
  [-1]: "cold", [-2]: "cold", [-3]: "cold",
};

// ─── Mandatory drafting formatting rules ──────────────────────────────────────
// Lives here (not in lib/services/llm.ts) so it can be imported by a client
// component too — Settings shows employees exactly what always applies on top
// of their personal drafting/reply prompt, since a personal prompt otherwise
// looks like it fully controls the output. lib/services/llm.ts re-exports this
// for the generation pipeline; there is only one copy of the rule text.
export const MANDATORY_FORMATTING_RULES =
  "\n\nFORMATTING (always applies, independent of the drafting style above):\n" +
  "- Bold the 2 to 4 most load-bearing facts using **double asterisks** — the matched " +
  "product/service name, and any concrete number, spec, or certification actually present " +
  "in the material (years of experience, capacity, certifications, countries served).\n" +
  "- Beyond those, bold any other word or short phrase that is genuinely important for a " +
  "skimming reader to catch at a glance (a key benefit, a name, a specific ask). Use judgement " +
  "— the email should never read as entirely plain text with nothing standing out, but never " +
  "bold a whole sentence or a vague phrase either.\n" +
  "- Use bullet pointers for any list of two or more items (offerings, strengths, features, " +
  "steps): each on its own line starting with \"- \", never run together in a single sentence.";


