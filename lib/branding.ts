// App branding: product identity (name/logo/copy) + color theme + light/dark
// mode. Every surface — page background, sidebar, cards, inputs, borders — is
// generated from a hue + mode pair, so each color has both a dark and a light
// variant (dark base + light accent shade in dark mode; light base + the same
// accent shade in light mode).

export const APP_NAME = "Kuber";
export const APP_LOGO_INITIAL = "K";
export const APP_TITLE = "Kuber Admin";
export const APP_DESCRIPTION = "Kuber demo admin workspace";
export const APP_TAGLINE = "Access the lead command center.";

export type ThemeId = "monochrome" | "blue" | "green" | "purple" | "orange" | "rose";
export type ThemeMode = "dark" | "light";

const CSS_VARS = [
  "--background", "--foreground",
  "--card", "--card-foreground",
  "--popover", "--popover-foreground",
  "--primary", "--primary-foreground",
  "--secondary", "--secondary-foreground",
  "--muted", "--muted-foreground",
  "--accent", "--accent-foreground",
  "--border", "--input", "--ring", "--field",
] as const;

type CssVar = (typeof CSS_VARS)[number];
type Palette = Record<CssVar, string>;

interface ColorDefinition {
  id: ThemeId;
  label: string;
  /** Hex color used for the swatch dot in the theme picker UI. */
  swatch: string;
  /** Hue in degrees, or null for the grayscale monochrome theme. */
  hue: number | null;
  accentSat: number;
  accentLight: number;
}

export const COLORS: ColorDefinition[] = [
  { id: "monochrome", label: "Monochrome",    swatch: "#fafafa", hue: null, accentSat: 0,  accentLight: 98 },
  { id: "blue",       label: "Ocean Blue",     swatch: "#3b82f6", hue: 217,  accentSat: 91, accentLight: 60 },
  { id: "green",      label: "Forest Green",   swatch: "#22c55e", hue: 142,  accentSat: 71, accentLight: 45 },
  { id: "purple",     label: "Royal Purple",   swatch: "#a855f7", hue: 271,  accentSat: 81, accentLight: 65 },
  { id: "orange",     label: "Sunset Orange",  swatch: "#f97316", hue: 25,   accentSat: 95, accentLight: 53 },
  { id: "rose",       label: "Rose",           swatch: "#f43f5e", hue: 350,  accentSat: 89, accentLight: 60 },
];

/** Builds a full dark-mode palette: near-black tinted background, progressively
 *  lighter tinted panels, and a saturated accent color (primary/ring). */
function buildDarkPalette(c: ColorDefinition): Palette {
  const mono = c.hue === null;
  const h = c.hue ?? 0;
  const s = mono ? 0 : 22;
  const fgS = mono ? 0 : 15;
  return {
    "--background":           `hsl(${h} ${mono ? 0 : 30}% 3.9%)`,
    "--foreground":           `hsl(${h} ${fgS}% 98%)`,
    "--card":                 `hsl(${h} ${mono ? 0 : 26}% 7%)`,
    "--card-foreground":      `hsl(${h} ${fgS}% 98%)`,
    "--popover":              `hsl(${h} ${mono ? 0 : 26}% 7%)`,
    "--popover-foreground":   `hsl(${h} ${fgS}% 98%)`,
    "--primary":              `hsl(${h} ${c.accentSat}% ${c.accentLight}%)`,
    "--primary-foreground":   mono ? "hsl(0 0% 9%)" : "hsl(0 0% 100%)",
    "--secondary":            `hsl(${h} ${s}% 14.9%)`,
    "--secondary-foreground": `hsl(${h} ${fgS}% 98%)`,
    "--muted":                `hsl(${h} ${s}% 14.9%)`,
    // 70% (was 63.9%) — AA contrast for small text on 7% cards (issues_ui §9).
    "--muted-foreground":     `hsl(${h} ${fgS}% 70%)`,
    "--accent":               `hsl(${h} ${s}% 16.9%)`,
    "--accent-foreground":    `hsl(${h} ${fgS}% 98%)`,
    "--border":                `hsl(${h} ${s}% 14.9%)`,
    "--input":                `hsl(${h} ${s}% 14.9%)`,
    "--ring":                 `hsl(${h} ${c.accentSat}% ${c.accentLight}%)`,
    // Field surface (Input/Select/Textarea/Checkbox/Radio/DatePicker fill) —
    // matches the page background in dark mode, same as the rest of the ladder.
    "--field":                `hsl(${h} ${mono ? 0 : 30}% 3.9%)`,
  };
}

/** Builds the light-mode palette under the client's strict 4-color rule:
 *  every value is one of primary, a single primary-tinted "shade" (used at
 *  full or reduced opacity — never a fifth arbitrary gray), full white, or
 *  black text (also opacity-only for the muted variant). No more per-token
 *  near-white lightness values (97%, 95.1%, 93.1%, 89.1%, ...).
 *
 *  White is reserved exclusively for actual field surfaces (--field, wired
 *  through bg-field on Input/Select/Textarea/Checkbox/Radio/DatePicker).
 *  Cards, popovers, and every panel/section fill are the same gray shade as
 *  the page — a card is a bordered gray region, not a white block, so a
 *  field placed inside it still contrasts. Never give a wrapper around a
 *  field its own white/card background "for emphasis" — that's what breaks
 *  the field's visibility (see CLAUDE.md). */
function buildLightPalette(c: ColorDefinition): Palette {
  const mono = c.hue === null;
  const h = c.hue ?? 0;
  const s = mono ? 0 : 20;
  const shade = `hsl(${h} ${s}% 95%)`;
  const white = "hsl(0 0% 100%)";
  const black = "hsl(0 0% 9%)";
  return {
    // Page / panel / card / nested-section fill — one flat "primary shade"
    // gray everywhere. Depth comes from border + shadow, not a second tone.
    "--background":           shade,
    "--secondary":            shade,
    "--muted":                shade,
    "--accent":               shade,
    "--card":                 shade,
    "--popover":              shade,
    // Field fill — the only white in the palette.
    "--field":                white,
    // Text — black, with the muted variant as an opacity of the same black
    // rather than a separate gray.
    "--foreground":           black,
    "--card-foreground":      black,
    "--popover-foreground":   black,
    "--secondary-foreground": black,
    "--accent-foreground":    black,
    "--muted-foreground":     "hsl(0 0% 9% / 0.6)",
    // Primary accent, unchanged.
    "--primary":              mono ? black : `hsl(${h} ${c.accentSat}% ${c.accentLight}%)`,
    "--primary-foreground":   mono ? "hsl(0 0% 98%)" : white,
    "--ring":                 mono ? black : `hsl(${h} ${c.accentSat}% ${c.accentLight}%)`,
    // Border/input line — same shade hue, one step darker so it stays visible
    // against both the white card and the shade background.
    "--border":               `hsl(${h} ${s}% 88%)`,
    "--input":                `hsl(${h} ${s}% 88%)`,
  };
}

export const DEFAULT_THEME_ID: ThemeId = "monochrome";
export const DEFAULT_THEME_MODE: ThemeMode = "dark";

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return !!value && COLORS.some((c) => c.id === value);
}

export function isThemeMode(value: string | null | undefined): value is ThemeMode {
  return value === "dark" || value === "light";
}

function getColor(id: string | null | undefined): ColorDefinition {
  return COLORS.find((c) => c.id === id) ?? COLORS[0];
}

export function getPalette(id: string | null | undefined, mode: ThemeMode): Palette {
  const color = getColor(id);
  return mode === "light" ? buildLightPalette(color) : buildDarkPalette(color);
}

export const THEME_STORAGE_KEY = "kuber-theme";
export const THEME_MODE_STORAGE_KEY = "kuber-theme-mode";

/** Applies a theme + mode's CSS custom properties to the document root. Safe to call before mount. */
export function applyTheme(id: string | null | undefined, mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const palette = getPalette(id, mode);
  const root = document.documentElement;
  for (const cssVar of CSS_VARS) root.style.setProperty(cssVar, palette[cssVar]);
  root.dataset.theme = getColor(id).id;
  root.dataset.mode = mode;
}
