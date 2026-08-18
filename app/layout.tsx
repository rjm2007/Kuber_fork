import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
import { APP_DESCRIPTION, APP_TITLE, THEME_MODE_STORAGE_KEY, THEME_STORAGE_KEY } from "@/lib/branding";

// One font, everywhere — Inter (self-hosted via next/font, no external
// request at runtime, zero layout shift). globals.css falls back to the
// system stack if the variable is absent. Do not add a second display/mono
// face — differentiate headings/data via weight, size, and tracking only.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: APP_TITLE,
  description: APP_DESCRIPTION
};

// Applies the cached theme + mode before paint so switching pages/reloading
// doesn't flash back to the defaults while settings load from the server.
// Mirrors lib/branding.ts's buildDarkPalette()/buildLightPalette() output —
// this has to be a plain string (not an import) since it must run before any
// JS bundle loads.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var COLORS = {
      monochrome: { hue: null, accentSat: 0,  accentLight: 98 },
      blue:       { hue: 217,  accentSat: 91, accentLight: 60 },
      green:      { hue: 142,  accentSat: 71, accentLight: 45 },
      purple:     { hue: 271,  accentSat: 81, accentLight: 65 },
      orange:     { hue: 25,   accentSat: 95, accentLight: 53 },
      rose:       { hue: 350,  accentSat: 89, accentLight: 60 }
    };
    function darkPalette(c) {
      var mono = c.hue === null;
      var h = c.hue || 0;
      var s = mono ? 0 : 22;
      var fgS = mono ? 0 : 15;
      return {
        "--background": "hsl(" + h + " " + (mono ? 0 : 30) + "% 3.9%)",
        "--foreground": "hsl(" + h + " " + fgS + "% 98%)",
        "--card": "hsl(" + h + " " + (mono ? 0 : 26) + "% 7%)",
        "--card-foreground": "hsl(" + h + " " + fgS + "% 98%)",
        "--popover": "hsl(" + h + " " + (mono ? 0 : 26) + "% 7%)",
        "--popover-foreground": "hsl(" + h + " " + fgS + "% 98%)",
        "--primary": "hsl(" + h + " " + c.accentSat + "% " + c.accentLight + "%)",
        "--primary-foreground": mono ? "hsl(0 0% 9%)" : "hsl(0 0% 100%)",
        "--secondary": "hsl(" + h + " " + s + "% 14.9%)",
        "--secondary-foreground": "hsl(" + h + " " + fgS + "% 98%)",
        "--muted": "hsl(" + h + " " + s + "% 14.9%)",
        "--muted-foreground": "hsl(" + h + " " + fgS + "% 70%)",
        "--accent": "hsl(" + h + " " + s + "% 16.9%)",
        "--accent-foreground": "hsl(" + h + " " + fgS + "% 98%)",
        "--border": "hsl(" + h + " " + s + "% 14.9%)",
        "--input": "hsl(" + h + " " + s + "% 14.9%)",
        "--ring": "hsl(" + h + " " + c.accentSat + "% " + c.accentLight + "%)",
        "--field": "hsl(" + h + " " + (mono ? 0 : 30) + "% 3.9%)"
      };
    }
    function lightPalette(c) {
      var mono = c.hue === null;
      var h = c.hue || 0;
      var s = mono ? 0 : 20;
      var shade = "hsl(" + h + " " + s + "% 95%)";
      var white = "hsl(0 0% 100%)";
      var black = "hsl(0 0% 9%)";
      return {
        "--background": shade,
        "--secondary": shade,
        "--muted": shade,
        "--accent": shade,
        "--card": shade,
        "--popover": shade,
        "--field": white,
        "--foreground": black,
        "--card-foreground": black,
        "--popover-foreground": black,
        "--secondary-foreground": black,
        "--accent-foreground": black,
        "--muted-foreground": "hsl(0 0% 9% / 0.6)",
        "--primary": mono ? black : "hsl(" + h + " " + c.accentSat + "% " + c.accentLight + "%)",
        "--primary-foreground": mono ? "hsl(0 0% 98%)" : white,
        "--ring": mono ? black : "hsl(" + h + " " + c.accentSat + "% " + c.accentLight + "%)",
        "--border": "hsl(" + h + " " + s + "% 88%)",
        "--input": "hsl(" + h + " " + s + "% 88%)"
      };
    }
    var id = localStorage.getItem("${THEME_STORAGE_KEY}");
    var mode = localStorage.getItem("${THEME_MODE_STORAGE_KEY}");
    var color = COLORS[id] || COLORS.monochrome;
    mode = mode === "light" ? "light" : "dark";
    var palette = mode === "light" ? lightPalette(color) : darkPalette(color);
    var root = document.documentElement;
    for (var key in palette) root.style.setProperty(key, palette[key]);
    root.dataset.theme = COLORS[id] ? id : "monochrome";
    root.dataset.mode = mode;
  } catch (e) {}
})();
`;

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={inter.variable}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
