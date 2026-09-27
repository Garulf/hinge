import type { AppEntry } from "./app-catalog";

function matches(app: AppEntry, query: string): boolean {
  return app.label.toLowerCase().includes(query) || app.pkg.toLowerCase().includes(query);
}

/** What the app picker shows: recents (known apps only, hidden while searching) and every matching app by label. */
export function pickerSections(apps: AppEntry[], recents: string[], query: string): { recents: AppEntry[]; all: AppEntry[] } {
  const q = query.trim().toLowerCase();
  const all = apps.filter((app) => matches(app, q)).sort((a, b) => a.label.localeCompare(b.label) || a.pkg.localeCompare(b.pkg));
  if (q !== "") return { recents: [], all };
  const byPkg = new Map(apps.map((app) => [app.pkg, app]));
  return { recents: recents.flatMap((pkg) => byPkg.get(pkg) ?? []), all };
}
