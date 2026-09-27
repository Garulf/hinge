/** The phone's call state as far as a ringing-call toast needs it, parsed from `dumpsys telephony.registry`. */
export interface CallState {
  ringing: boolean;
  /** Empty when the caller withheld it or the build redacts it. */
  number: string;
}

const CALL_STATE_RINGING = 1;
const DIALABLE = /^\+?[0-9*#]+$/;

function lineValue(block: string, name: string): string | null {
  const match = new RegExp(`^\\s*${name}=(.*)$`, "m").exec(block);
  return match ? match[1].trim() : null;
}

/** A dual-SIM phone prints one `Phone Id=<n>` block per modem; the call is ringing if any of them is. */
export function parseCallState(dumpsysText: string): CallState {
  const perPhone = dumpsysText.split(/^\s*Phone Id=\d+\s*$/m);
  const blocks = perPhone.length > 1 ? perPhone.slice(1) : perPhone;
  for (const block of blocks) {
    if (Number(lineValue(block, "mCallState")) === CALL_STATE_RINGING) {
      return { ringing: true, number: lineValue(block, "mCallIncomingNumber") ?? "" };
    }
  }
  return { ringing: false, number: "" };
}

/** Null for anything but a dialable number, so text from dumpsys never reaches the shell unchecked. */
export function phoneLookupCommand(number: string): string | null {
  if (!DIALABLE.test(number)) return null;
  const uri = `content://com.android.contacts/phone_lookup/${encodeURIComponent(number)}`;
  return `content query --uri ${uri} --projection display_name`;
}

/** Reads `Row: 0 display_name=<name>`; `No result found.` means the number is not a contact. */
export function parseContactName(contentQueryText: string): string | null {
  const name = /display_name=(.*)$/m.exec(contentQueryText)?.[1].trim();
  return name && name !== "NULL" ? name : null;
}

export function incomingCallBody(contactName: string | null, number: string): string {
  return contactName ?? (number || "Unknown caller");
}
