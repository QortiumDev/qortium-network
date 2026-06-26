// Maps an ISO 3166-1 alpha-2 country code to a bundled circular flag SVG.
// Flags are vendored from the `circle-flags` package (see src/assets/flags).
// Each SVG is tiny (<3 KB) so Vite inlines them into the bundle as data URIs —
// every flag is available instantly and offline, which suits a QDN app.
const flagModules = import.meta.glob('./assets/flags/*.svg', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;

const flagUrlByCode: Record<string, string> = {};

for (const [path, url] of Object.entries(flagModules)) {
  const code = path.slice(path.lastIndexOf('/') + 1, -'.svg'.length);

  flagUrlByCode[code] = url;
}

export function flagUrl(country: string | null | undefined): string | undefined {
  if (!country) {
    return undefined;
  }

  return flagUrlByCode[country.toLowerCase()];
}

const regionNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : undefined;

// Human-readable country name for an ISO alpha-2 code (e.g. "US" -> "United
// States"). Falls back to the upper-cased code when the runtime can't resolve it.
export function countryName(country: string | null | undefined): string | undefined {
  if (!country) {
    return undefined;
  }

  const code = country.toUpperCase();

  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}
