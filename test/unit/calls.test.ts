import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { incomingCallBody, parseCallState, parseContactName, phoneLookupCommand } from "../../src/shared/calls";

// Built from AOSP's TelephonyRegistry.dump() layout, not captured from the Fold 7: unverified against Samsung's build.
const RINGING = readFileSync(join(import.meta.dirname, "../fixtures/dumpsys-telephony-registry-ringing-aosp.txt"), "utf8");
const IDLE = RINGING.replace("mCallState=1", "mCallState=0").replace("mCallIncomingNumber=+15551234567", "mCallIncomingNumber=");
const OFFHOOK = RINGING.replace("mCallState=1", "mCallState=2");

test("parseCallState finds the ringing phone and its incoming number", () => {
  expect(parseCallState(RINGING)).toEqual({ ringing: true, number: "+15551234567" });
});

test("parseCallState reports not ringing once every phone is idle", () => {
  expect(parseCallState(IDLE)).toEqual({ ringing: false, number: "" });
});

test("an answered call is off hook, not ringing", () => {
  expect(parseCallState(OFFHOOK).ringing).toBe(false);
});

test("a ringing second SIM is found even while the first is idle", () => {
  const secondRinging = IDLE.replace(/(Phone Id=1\n\s+)mCallState=0/, "$1mCallState=1").replace(
    /(Phone Id=1[\s\S]*?)mCallIncomingNumber=/,
    "$1mCallIncomingNumber=5559876",
  );
  expect(parseCallState(secondRinging)).toEqual({ ringing: true, number: "5559876" });
});

test("a ringing phone with its number withheld still counts as ringing", () => {
  const hidden = RINGING.replace("mCallIncomingNumber=+15551234567", "mCallIncomingNumber=");
  expect(parseCallState(hidden)).toEqual({ ringing: true, number: "" });
});

test("text with no call state at all is not ringing", () => {
  expect(parseCallState("Can't find service: telephony.registry\n")).toEqual({ ringing: false, number: "" });
});

test("phoneLookupCommand url-encodes the plus of an international number", () => {
  expect(phoneLookupCommand("+15551234567")).toBe(
    "content query --uri content://com.android.contacts/phone_lookup/%2B15551234567 --projection display_name",
  );
});

test("phoneLookupCommand refuses anything that is not a dialable number, so nothing else reaches the shell", () => {
  expect(phoneLookupCommand("")).toBeNull();
  expect(phoneLookupCommand("555; rm -rf /")).toBeNull();
  expect(phoneLookupCommand("$(reboot)")).toBeNull();
});

test("parseContactName reads the display name off a content query row", () => {
  expect(parseContactName("Row: 0 display_name=Alex Doe\n")).toBe("Alex Doe");
});

test("parseContactName is null when the number is not a contact", () => {
  expect(parseContactName("No result found.\n")).toBeNull();
});

test("the toast body prefers the contact name, then the number, then says the caller is unknown", () => {
  expect(incomingCallBody("Alex Doe", "+15551234567")).toBe("Alex Doe");
  expect(incomingCallBody(null, "+15551234567")).toBe("+15551234567");
  expect(incomingCallBody(null, "")).toBe("Unknown caller");
});
