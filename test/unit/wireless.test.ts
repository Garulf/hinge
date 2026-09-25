import { expect, test } from "vitest";
import { pairNewDevice, parseWlanIp, switchDeviceToWifi, type WirelessDeps } from "../../src/main/wireless";

function fakeDeps(overrides?: Partial<WirelessDeps>): { deps: WirelessDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { pair: [], connect: [], disconnect: [], mdnsServices: [], setTcpIpPort: [], wlanIp: [] };
  const deps: WirelessDeps = {
    pair: async (hostPort, code) => {
      calls.pair.push([hostPort, code]);
    },
    connect: async (address) => {
      calls.connect.push([address]);
    },
    disconnect: async (address) => {
      calls.disconnect.push([address]);
    },
    mdnsServices: async () => {
      calls.mdnsServices.push([]);
      return [];
    },
    setTcpIpPort: async (adb, port) => {
      calls.setTcpIpPort.push([adb, port]);
    },
    wlanIp: async (adb) => {
      calls.wlanIp.push([adb]);
      return null;
    },
    ...overrides,
  };
  return { deps, calls };
}

test("parseWlanIp extracts the inet address from `ip -4 addr show wlan0` output", () => {
  const output = [
    "3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default qlen 1000",
    "    inet 192.168.1.42/24 brd 192.168.1.255 scope global wlan0",
    "       valid_lft forever preferred_lft forever",
  ].join("\n");
  expect(parseWlanIp(output)).toBe("192.168.1.42");
});

test("parseWlanIp returns null when wlan0 has no address (Wi-Fi off) or the command failed", () => {
  expect(parseWlanIp("")).toBeNull();
  expect(parseWlanIp("Device \"wlan0\" does not exist.")).toBeNull();
});

test("pairNewDevice pairs, then finds the connect service via mDNS matching the paired host and connects to it", async () => {
  const { deps, calls } = fakeDeps({
    mdnsServices: async () => [
      { name: "adb-R3-abc", service: "_adb-tls-pairing._tcp", address: "192.168.1.42:37000" },
      { name: "adb-R3-abc", service: "_adb-tls-connect._tcp", address: "192.168.1.42:41231" },
    ],
  });
  const result = await pairNewDevice(deps, "192.168.1.42:37251", "123456");

  expect(calls.pair).toEqual([["192.168.1.42:37251", "123456"]]);
  expect(calls.connect).toEqual([["192.168.1.42:41231"]]);
  expect(result).toEqual({ paired: true, connectedAddress: "192.168.1.42:41231" });
});

test("pairNewDevice polls for the mDNS connect service to appear, and gives up after the configured attempts without connecting", async () => {
  let call = 0;
  const delays: number[] = [];
  const { deps, calls } = fakeDeps({
    mdnsServices: async () => {
      call++;
      if (call < 3) return [];
      return [{ name: "x", service: "_adb-tls-connect._tcp", address: "192.168.1.42:5000" }];
    },
  });
  const result = await pairNewDevice(deps, "192.168.1.42:37251", "123456", {
    delay: async (ms) => {
      delays.push(ms);
    },
  });

  expect(result).toEqual({ paired: true, connectedAddress: "192.168.1.42:5000" });
  expect(calls.connect).toEqual([["192.168.1.42:5000"]]);
  expect(delays.length).toBeGreaterThan(0);
});

test("pairNewDevice reports paired but not connected when no matching mDNS service ever appears, so the caller can ask for the port instead", async () => {
  const { deps, calls } = fakeDeps();
  const result = await pairNewDevice(deps, "192.168.1.42:37251", "123456", {
    pollAttempts: 2,
    delay: async () => {},
  });

  expect(result).toEqual({ paired: true, connectedAddress: null });
  expect(calls.connect).toEqual([]);
});

test("pairNewDevice does not swallow a pairing failure: it rejects before ever touching mDNS", async () => {
  const { deps, calls } = fakeDeps({
    pair: async () => {
      throw new Error("wrong code");
    },
  });
  await expect(pairNewDevice(deps, "192.168.1.42:37251", "000000")).rejects.toThrow("wrong code");
  expect(calls.mdnsServices).toEqual([]);
});

test("switchDeviceToWifi sets the tcpip port then connects to the device's own wlan0 address on port 5555", async () => {
  const fakeAdb = { marker: "adb" } as never;
  const { deps, calls } = fakeDeps({
    wlanIp: async (adb) => {
      calls.wlanIp.push([adb]);
      return "192.168.1.77";
    },
  });
  const address = await switchDeviceToWifi(deps, fakeAdb);

  expect(calls.wlanIp).toEqual([[fakeAdb]]);
  expect(calls.setTcpIpPort).toEqual([[fakeAdb, 5555]]);
  expect(calls.connect).toEqual([["192.168.1.77:5555"]]);
  expect(address).toBe("192.168.1.77:5555");
});

test("switchDeviceToWifi fails clearly when the device has no Wi-Fi IP (Wi-Fi off) instead of connecting to a bogus address", async () => {
  const fakeAdb = { marker: "adb" } as never;
  const { deps, calls } = fakeDeps({ wlanIp: async () => null });
  await expect(switchDeviceToWifi(deps, fakeAdb)).rejects.toThrow(/wlan0|wi-?fi/i);
  expect(calls.setTcpIpPort).toEqual([]);
  expect(calls.connect).toEqual([]);
});
