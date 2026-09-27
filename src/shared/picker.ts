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

/** One "apps" answer as the picker keeps it. */
export interface PickerListing {
  id: number;
  apps: AppEntry[];
  recents: string[];
  icons: Record<string, string>;
  error: string | null;
}

function sameList(a: PickerListing, b: PickerListing): boolean {
  return (
    a.error === b.error &&
    a.apps.length === b.apps.length &&
    a.apps.every((app, i) => app.pkg === b.apps[i].pkg && app.label === b.apps[i].label) &&
    a.recents.length === b.recents.length &&
    a.recents.every((pkg, i) => pkg === b.recents[i])
  );
}

/** What an incoming answer does to the picker: nothing when it answers an earlier request, add icons when it repeats the shown list, else replace it. */
export function listingChange(requested: number, shown: PickerListing | null, incoming: PickerListing): "stale" | "icons" | "list" {
  if (incoming.id !== requested) return "stale";
  return shown && shown.id === incoming.id && sameList(shown, incoming) ? "icons" : "list";
}
