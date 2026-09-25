import { expect, test } from "vitest";
import { PROBE_TIMELINE_EXTRA_COMMANDS, waitForDevice, type DeviceLister } from "../../src/main/probe";

function hostOf(devices: Awaited<ReturnType<DeviceLister["getDevices"]>>): { client: DeviceLister } {
  return { client: { getDevices: async () => devices } };
}

test("returns as soon as a device is fully authorized", async () => {
  const progress: string[] = [];
  const device = await waitForDevice(hostOf([{ serial: "S1", state: "device", model: "Pixel" }]), null, (t) => progress.push(t));
  expect(device.serial).toBe("S1");
  expect(progress).toEqual(["Waiting for a phone..."]);
});

test("shows a prompt to allow USB debugging instead of waiting silently on an unauthorized phone", async () => {
  let calls = 0;
  const devices = [{ serial: "S1", state: "unauthorized", model: null }];
  const host = {
    client: {
      getDevices: async () => {
        calls++;
        if (calls >= 3) devices[0]!.state = "device";
        return devices;
      },
    },
  };
  const progress: string[] = [];
  const device = await waitForDevice(host, null, (t) => progress.push(t));
  expect(device.state).toBe("device");
  expect(progress).toContain("Allow USB debugging on your phone");
});

test("the probe's timeline samples wm size alongside the posture commands", () => {
  expect(PROBE_TIMELINE_EXTRA_COMMANDS).toContain("wm size");
});
