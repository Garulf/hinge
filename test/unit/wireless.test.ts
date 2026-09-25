import { expect, test } from "vitest";
import { AdbServerClient } from "@yume-chan/adb";
import { connectOrAlreadyConnected, pairNewDevice, parseWlanIp, switchDeviceToWifi, type WirelessDeps } from "../../src/main/wireless";

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

test("switchDeviceToWifi retries connect while adbd is restarting in TCP mode, succeeding once it comes back", async () => {
  const fakeAdb = { marker: "adb" } as never;
  let attempts = 0;
  const delays: number[] = [];
  const { deps, calls } = fakeDeps({
    wlanIp: async () => "192.168.1.77",
    connect: async (address) => {
      calls.connect.push([address]);
      attempts++;
      if (attempts <= 2) throw new Error("connection refused (adbd restarting)");
    },
  });
  const address = await switchDeviceToWifi(deps, fakeAdb, {
    delay: async (ms) => {
      delays.push(ms);
    },
  });

  expect(address).toBe("192.168.1.77:5555");
  expect(attempts).toBe(3);
  expect(delays).toEqual([300, 300]);
});

test("switchDeviceToWifi gives up after 10 failed connect attempts", async () => {
  const fakeAdb = { marker: "adb" } as never;
  let attempts = 0;
  const { deps } = fakeDeps({
    wlanIp: async () => "192.168.1.77",
    connect: async () => {
      attempts++;
      throw new Error("still refused");
    },
  });
  await expect(switchDeviceToWifi(deps, fakeAdb, { delay: async () => {} })).rejects.toThrow("still refused");
  expect(attempts).toBe(10);
});

test("pairNewDevice reports paired ok with connectedAddress null and a message when the mDNS service is found but connect() itself fails", async () => {
  const { deps, calls } = fakeDeps({
    mdnsServices: async () => [{ name: "x", service: "_adb-tls-connect._tcp", address: "192.168.1.42:5000" }],
    connect: async (address) => {
      calls.connect.push([address]);
      throw new Error("connection refused");
    },
  });
  const result = await pairNewDevice(deps, "192.168.1.42:37251", "123456");

  expect(result.paired).toBe(true);
  expect(result.connectedAddress).toBeNull();
  expect(result.message).toContain("connection refused");
});

function alreadyConnected(address: string): Error {
  return new AdbServerClient.AlreadyConnectedError(`already connected to ${address}`);
}

test("connectOrAlreadyConnected treats adb's 'already connected' as success and still rejects anything else", async () => {
  const { deps } = fakeDeps({ connect: async (address) => { throw alreadyConnected(address); } });
  await expect(connectOrAlreadyConnected(deps, "10.0.0.5:5555")).resolves.toBeUndefined();

  const failing = fakeDeps({ connect: async () => { throw new AdbServerClient.NetworkError("failed"); } });
  await expect(connectOrAlreadyConnected(failing.deps, "10.0.0.5:5555")).rejects.toThrow("failed");
});

test("pairNewDevice counts an already-connected connect service as connected", async () => {
  const { deps } = fakeDeps({
    mdnsServices: async () => [{ name: "adb-R3-abc", service: "_adb-tls-connect._tcp", address: "192.168.1.42:41231" }],
    connect: async (address) => { throw alreadyConnected(address); },
  });
  expect(await pairNewDevice(deps, "192.168.1.42:37251", "123456")).toEqual({ paired: true, connectedAddress: "192.168.1.42:41231" });
});

test("switchDeviceToWifi counts an already-connected address as connected instead of retrying it", async () => {
  let attempts = 0;
  const { deps } = fakeDeps({
    wlanIp: async () => "192.168.1.42",
    connect: async (address) => {
      attempts++;
      throw alreadyConnected(address);
    },
  });
  expect(await switchDeviceToWifi(deps, {} as never, { delay: async () => {} })).toBe("192.168.1.42:5555");
  expect(attempts).toBe(1);
});
