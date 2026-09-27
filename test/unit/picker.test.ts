import { expect, test } from "vitest";
import type { AppEntry } from "../../src/shared/app-catalog";
import { pickerSections } from "../../src/shared/picker";

const APPS: AppEntry[] = [
  { pkg: "com.example.notes", label: "notes", versionCode: 3 },
  { pkg: "com.example.chat", label: "Chat", versionCode: 42 },
  { pkg: "org.maps.app", label: "Maps", versionCode: 7 },
  { pkg: "com.example.alarm", label: "Élan Alarm", versionCode: 1 },
];

function labels(apps: AppEntry[]): string[] {
  return apps.map((a) => a.label);
}

test("with no query, recents follow the phone's order and all apps are sorted by label", () => {
  const sections = pickerSections(APPS, ["org.maps.app", "com.example.chat"], "");
  expect(labels(sections.recents)).toEqual(["Maps", "Chat"]);
  expect(labels(sections.all)).toEqual(["Chat", "Élan Alarm", "Maps", "notes"]);
});

test("recents the app list does not know are dropped", () => {
  const sections = pickerSections(APPS, ["com.android.systemui", "com.example.notes", "com.gone.app"], "");
  expect(labels(sections.recents)).toEqual(["notes"]);
});

test("a query matches the label or the package, ignoring case", () => {
  expect(labels(pickerSections(APPS, [], "CHA").all)).toEqual(["Chat"]);
  expect(labels(pickerSections(APPS, [], "org.maps").all)).toEqual(["Maps"]);
  expect(labels(pickerSections(APPS, [], "example").all)).toEqual(["Chat", "Élan Alarm", "notes"]);
});

test("recents are hidden while a query is typed", () => {
  expect(pickerSections(APPS, ["com.example.chat"], "chat").recents).toEqual([]);
});

test("a query of only spaces counts as none", () => {
  const sections = pickerSections(APPS, ["com.example.chat"], "   ");
  expect(labels(sections.recents)).toEqual(["Chat"]);
  expect(sections.all).toHaveLength(4);
});

test("a query that matches nothing leaves both sections empty", () => {
  expect(pickerSections(APPS, ["com.example.chat"], "zzz")).toEqual({ recents: [], all: [] });
});

test("the input list is left in its order", () => {
  const apps = [...APPS];
  pickerSections(apps, [], "");
  expect(apps).toEqual(APPS);
});
