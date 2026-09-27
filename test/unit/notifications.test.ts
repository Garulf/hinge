import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { diffNotifications, isMirrorable, parseNotifications, type NotificationRecord } from "../../src/shared/notifications";

const FIXTURE = readFileSync(join(import.meta.dirname, "../fixtures/dumpsys-notification-sample.txt"), "utf8");

function byKey(records: NotificationRecord[], key: string): NotificationRecord {
  const found = records.find((r) => r.key === key);
  if (!found) throw new Error(`no record with key ${key} in fixture`);
  return found;
}

test("parseNotifications reads every field off a real dumpsys notification --noredact block", () => {
  const records = parseNotifications(FIXTURE);
  const alex = byKey(records, "0|com.example.chat|501|null|10201");
  expect(alex).toEqual({
    key: "0|com.example.chat|501|null|10201",
    pkg: "com.example.chat",
    title: "Alex",
    text: "Are we still meeting at noon?",
    postTime: 1758870001000,
    flags: 0x10,
    importance: 3,
    groupSummary: false,
  });
});

test("parseNotifications reads the whole fixture's record count", () => {
  expect(parseNotifications(FIXTURE)).toHaveLength(7);
});

test("parseNotifications recognises a group summary from its flag bit", () => {
  const summary = byKey(parseNotifications(FIXTURE), "0|com.example.chat|600|null|10201");
  expect(summary.groupSummary).toBe(true);
  expect(summary.flags & 0x200).not.toBe(0);
});

test("parseNotifications unwraps extras that AOSP prints as their class name and the value in brackets", () => {
  const block = [
    "  NotificationRecord(0x3c4d5e6: pkg=com.example.mail user=UserHandle{0} id=7 tag=null key=0|com.example.mail|7|null|10300: Notification(channel=inbox pri=0 flags=0x10))",
    "    pkg=com.example.mail",
    "    key=0|com.example.mail|7|null|10300",
    "    flags=0x10",
    "      extras={",
    "        android.title=String (Sam)",
    "        android.text=SpannableString (Lunch (the usual place)?)",
    "        android.subText=null",
    "      }",
  ].join("\n");
  const [mail] = parseNotifications(block);
  expect(mail.title).toBe("Sam");
  expect(mail.text).toBe("Lunch (the usual place)?");
});

test("parseNotifications reads an empty title and text as empty strings, not undefined", () => {
  const blank = byKey(parseNotifications(FIXTURE), "0|com.example.chat|99|null|10201");
  expect(blank.title).toBe("");
  expect(blank.text).toBe("");
});

test("isMirrorable skips a group summary", () => {
  const summary = byKey(parseNotifications(FIXTURE), "0|com.example.chat|600|null|10201");
  expect(isMirrorable(summary)).toBe(false);
});

test("isMirrorable skips an ongoing and foreground-service notification", () => {
  const media = byKey(parseNotifications(FIXTURE), "0|com.example.music|1|null|10305");
  expect(media.flags & 0x2).not.toBe(0);
  expect(media.flags & 0x40).not.toBe(0);
  expect(isMirrorable(media)).toBe(false);
});

test("isMirrorable skips an ongoing notification on its own", () => {
  const download = byKey(parseNotifications(FIXTURE), "0|com.example.download|7|null|10520");
  expect(isMirrorable(download)).toBe(false);
});

test("isMirrorable skips importance below default: low and min", () => {
  const low = byKey(parseNotifications(FIXTURE), "0|com.example.forum|88|null|10410");
  const min = byKey(parseNotifications(FIXTURE), "0|com.example.forum|89|null|10410");
  expect(isMirrorable(low)).toBe(false);
  expect(isMirrorable(min)).toBe(false);
});

test("isMirrorable skips a notification with neither title nor text", () => {
  const blank = byKey(parseNotifications(FIXTURE), "0|com.example.chat|99|null|10201");
  expect(isMirrorable(blank)).toBe(false);
});

test("isMirrorable accepts an ordinary default-importance notification with a title and text", () => {
  const alex = byKey(parseNotifications(FIXTURE), "0|com.example.chat|501|null|10201");
  expect(isMirrorable(alex)).toBe(true);
});

function record(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    key: "0|com.example.chat|1|null|10201",
    pkg: "com.example.chat",
    title: "Alex",
    text: "hi",
    postTime: 1000,
    flags: 0,
    importance: 3,
    groupSummary: false,
    ...overrides,
  };
}

test("the first diff after a phone starts streaming only seeds the known set", () => {
  const a = record();
  const result = diffNotifications(new Map(), [a], false);
  expect(result.toShow).toEqual([]);
  expect(result.known).toEqual(new Map([[a.key, a.postTime]]));
});

test("a brand new key is shown once seeded", () => {
  const a = record();
  const { known } = diffNotifications(new Map(), [], true);
  const result = diffNotifications(known, [a], true);
  expect(result.toShow).toEqual([a]);
});

test("a known key reposted with the same postTime is not shown again", () => {
  const a = record();
  const seeded = diffNotifications(new Map(), [a], false);
  const result = diffNotifications(seeded.known, [a], true);
  expect(result.toShow).toEqual([]);
});

test("a known key reposted with a newer postTime is shown again", () => {
  const a = record();
  const seeded = diffNotifications(new Map(), [a], false);
  const reposted = { ...a, postTime: a.postTime + 1 };
  const result = diffNotifications(seeded.known, [reposted], true);
  expect(result.toShow).toEqual([reposted]);
});

test("a key removed and then re-added is treated as new, not suppressed", () => {
  const a = record();
  const other = record({ key: "0|com.example.chat|2|null|10201", postTime: 500 });
  const seeded = diffNotifications(new Map(), [a, other], false);
  // a's key drops off a still-nonempty poll: a genuine removal, not a bad read.
  const removed = diffNotifications(seeded.known, [other], true);
  expect(removed.known.has(a.key)).toBe(false);
  const readded = diffNotifications(removed.known, [a, other], true);
  expect(readded.toShow).toEqual([a]);
});

test("a poll that parses no records at all keeps the previous known set instead of clearing it", () => {
  const a = record();
  const seeded = diffNotifications(new Map(), [a], false);
  const badRead = diffNotifications(seeded.known, [], true);
  // a genuinely empty phone would also look like this; the mirror trades a
  // stale known set for never re-flooding after a bad parse.
  expect(badRead.known).toEqual(seeded.known);
  const stillKnown = diffNotifications(badRead.known, [a], true);
  expect(stillKnown.toShow).toEqual([]);
});
