/** A phone notification as mirrored to the PC, parsed from `dumpsys notification --noredact`. */
export interface NotificationRecord {
  /** The system's own `userId|pkg|id|tag|uid` notification key, stable across reposts. */
  key: string;
  pkg: string;
  title: string;
  text: string;
  postTime: number;
  flags: number;
  importance: number;
  groupSummary: boolean;
}

const FLAG_ONGOING_EVENT = 0x2;
const FLAG_FOREGROUND_SERVICE = 0x40;
const FLAG_GROUP_SUMMARY = 0x200;

const IMPORTANCE_DEFAULT = 3;

const RECORD_HEADER = /^\s*NotificationRecord\(/m;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function field(block: string, name: string): string | null {
  const match = new RegExp(`^\\s*${escapeRegExp(name)}=(.*)$`, "m").exec(block);
  return match ? match[1].trim() : null;
}

function extrasBlock(block: string): string | null {
  const start = block.indexOf("extras={");
  if (start < 0) return null;
  const end = block.indexOf("}", start);
  return end < 0 ? block.slice(start) : block.slice(start, end);
}

function extraField(extras: string, name: string): string {
  const match = new RegExp(`^\\s*${escapeRegExp(name)}=(.*)$`, "m").exec(extras);
  return match ? match[1].trim() : "";
}

function toImportance(raw: string | null): number {
  if (raw === null) return IMPORTANCE_DEFAULT;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber;
  const named = /IMPORTANCE_(\w+)/.exec(raw)?.[1];
  const byName: Record<string, number> = { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 };
  return named && named in byName ? byName[named] : IMPORTANCE_DEFAULT;
}

function toFlags(raw: string | null): number {
  if (raw === null) return 0;
  return raw.startsWith("0x") ? Number.parseInt(raw.slice(2), 16) : Number(raw) || 0;
}

/** Splits `dumpsys notification --noredact` text on each `NotificationRecord(` block and reads the fields the mirror needs off it. */
export function parseNotifications(dumpsysText: string): NotificationRecord[] {
  const blocks = dumpsysText.split(RECORD_HEADER).slice(1);
  return blocks.map((block) => {
    const key = field(block, "key") ?? "";
    const pkg = field(block, "pkg") ?? "";
    const postTime = Number(field(block, "postTime") ?? field(block, "when") ?? "0");
    const flags = toFlags(field(block, "flags"));
    const importance = toImportance(field(block, "importance"));
    const extras = extrasBlock(block);
    const title = extras ? extraField(extras, "android.title") : "";
    const text = extras ? extraField(extras, "android.text") : "";
    return { key, pkg, title, text, postTime, flags, importance, groupSummary: (flags & FLAG_GROUP_SUMMARY) !== 0 };
  });
}

/** The skip rules from the brief: ongoing/foreground-service, group summaries, below-default importance, and a notification with neither title nor text. */
export function isMirrorable(record: NotificationRecord): boolean {
  if (record.groupSummary) return false;
  if ((record.flags & FLAG_ONGOING_EVENT) !== 0) return false;
  if ((record.flags & FLAG_FOREGROUND_SERVICE) !== 0) return false;
  if (record.importance < IMPORTANCE_DEFAULT) return false;
  if (!record.title && !record.text) return false;
  return true;
}

export interface NotificationDiff {
  toShow: NotificationRecord[];
  known: Map<string, number>;
}

/**
 * `known` maps a notification key to the postTime it was last seen at, and
 * only ever reflects the most recent non-empty poll: a key absent from a
 * non-empty poll is dropped, so if it reappears later it counts as new
 * rather than a suppressed repost. An empty `records` is treated as a bad
 * read (a parse that found nothing) rather than "the phone has no
 * notifications", and leaves `known` untouched so a transient bad poll can
 * never re-flood everything once a good one follows. `seeded` is false only
 * for the very first poll of a session, so it never shows notifications
 * that were already on the phone before hinge started watching it.
 */
export function diffNotifications(known: ReadonlyMap<string, number>, records: readonly NotificationRecord[], seeded: boolean): NotificationDiff {
  if (records.length === 0) return { toShow: [], known: new Map(known) };
  const toShow = seeded
    ? records.filter((r) => {
        const prev = known.get(r.key);
        return prev === undefined || r.postTime > prev;
      })
    : [];
  return { toShow, known: new Map(records.map((r) => [r.key, r.postTime])) };
}
