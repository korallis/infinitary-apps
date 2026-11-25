import { describe, expect, it } from "vitest";
import { addressIsProxy, createProxyAppReader, lsofEndpoint, readProxySettings } from "./proxyApp";

// The captain's choice: Infinitary reads the proxy's key from the proxy
// app's own settings file (docs/quota.md, "A proxy's pooled logins"). The
// file follows EasyCLIProxyAPI's config.toml layout, with made-up keys.
const SETTINGS = [
  "# EasyCLIProxyAPI settings",
  "port = 8317",
  'host = ""',
  'management-secret-key = "Mk7q2Vz9Lp4X"',
  'api-keys = ["sk-client-one", "sk-client-two"]',
  "debug = false",
  "",
  "[auto-update]",
  "port = 9999",
  'management-secret-key = "not-this-one"',
].join("\r\n");

describe("readProxySettings", () => {
  it("reads the port, the management key and the first client key, before any table", () => {
    expect(readProxySettings(SETTINGS)).toEqual({
      origin: "http://127.0.0.1:8317",
      port: 8317,
      key: "Mk7q2Vz9Lp4X",
      clientKey: "sk-client-one",
    });
  });

  it("refuses a proxy set to listen on another computer's address", () => {
    expect(readProxySettings(SETTINGS.replace('host = ""', 'host = "192.168.1.20"'))).toBe(
      undefined,
    );
  });

  it("reads nothing without a management key", () => {
    expect(readProxySettings(SETTINGS.replace('management-secret-key = "Mk7q2Vz9Lp4X"', ""))).toBe(
      undefined,
    );
  });
});

describe("addressIsProxy", () => {
  it.each([
    ["http://127.0.0.1:8317", true],
    ["http://localhost:8317/v1", true],
    ["https://127.0.0.1:8317", false],
    ["http://127.0.0.1:8318", false],
    ["http://proxy.example.com:8317", false],
    ["not an address", false],
  ])("%s goes to the proxy on port 8317: %s", (address, expected) => {
    expect(addressIsProxy(address, 8317)).toBe(expected);
  });
});

describe("createProxyAppReader", () => {
  const PROGRAM = "C:\\Tools\\EasyCLIProxyAPI\\EasyCLIProxyAPI.exe";

  it("reads the settings beside the running proxy, asking the system again on each read", async () => {
    let finds = 0;
    const reads: string[] = [];
    const reader = createProxyAppReader(
      async () => {
        finds += 1;
        return [{ program: PROGRAM, endpoints: [{ address: "127.0.0.1", port: 8317 }] }];
      },
      async (path) => {
        reads.push(path);
        return SETTINGS;
      },
    );
    expect((await reader())?.port).toBe(8317);
    expect((await reader())?.port).toBe(8317);
    expect(finds).toBe(2);
    expect(reads[0]?.replaceAll("\\", "/")).toBe("C:/Tools/EasyCLIProxyAPI/config.toml");
  });

  // The review's finding: the keys go only to a port the proxy itself
  // listens on now, never to whatever took a port a saved file names.
  it("reads nothing when the port the settings name is not the proxy's", async () => {
    const reader = createProxyAppReader(
      async () => [{ program: PROGRAM, endpoints: [{ address: "127.0.0.1", port: 9000 }] }],
      async () => SETTINGS,
    );
    expect(await reader()).toBe(undefined);
  });

  // The review's finding: the keys go to the loopback address the proxy
  // itself listens on, so a proxy on IPv6 alone is sent them there, never at
  // an IPv4 port another program may hold, and one listening only on
  // another interface is not read.
  it.each([
    ["127.0.0.1", "http://127.0.0.1:8317"],
    ["0.0.0.0", "http://127.0.0.1:8317"],
    ["::1", "http://[::1]:8317"],
    ["::", "http://[::1]:8317"],
    ["192.168.1.20", undefined],
  ])("sends the keys to where a proxy listening on %s answers: %s", async (address, origin) => {
    const reader = createProxyAppReader(
      async () => [{ program: PROGRAM, endpoints: [{ address, port: 8317 }] }],
      async () => SETTINGS,
    );
    expect((await reader())?.origin).toBe(origin);
  });

  it("prefers IPv4 loopback when the proxy listens on both", async () => {
    const reader = createProxyAppReader(
      async () => [
        {
          program: PROGRAM,
          endpoints: [
            { address: "::1", port: 8317 },
            { address: "127.0.0.1", port: 8317 },
          ],
        },
      ],
      async () => SETTINGS,
    );
    expect((await reader())?.origin).toBe("http://127.0.0.1:8317");
  });

  it("reads nothing once the proxy has exited, though its settings file is still there", async () => {
    let running = true;
    const reader = createProxyAppReader(
      async () =>
        running ? [{ program: PROGRAM, endpoints: [{ address: "127.0.0.1", port: 8317 }] }] : [],
      async () => SETTINGS,
    );
    expect((await reader())?.port).toBe(8317);
    running = false;
    expect(await reader()).toBe(undefined);
  });

  it("asks the system again only after the wait while no proxy runs", async () => {
    let finds = 0;
    let now = 0;
    const reader = createProxyAppReader(
      async () => {
        finds += 1;
        return [];
      },
      async () => SETTINGS,
      () => now,
      5 * 60_000,
    );
    expect(await reader()).toBe(undefined);
    now = 4 * 60_000;
    expect(await reader()).toBe(undefined);
    expect(finds).toBe(1);
    now = 5 * 60_000;
    await reader();
    expect(finds).toBe(2);
  });
});

// What `lsof -Fptn` names a listening socket, read as an endpoint: the
// wildcard `*` is every address of the socket's own family.
describe("lsofEndpoint", () => {
  it.each([
    ["127.0.0.1:8317", "IPv4", { address: "127.0.0.1", port: 8317 }],
    ["[::1]:8317", "IPv6", { address: "::1", port: 8317 }],
    ["*:8317", "IPv4", { address: "0.0.0.0", port: 8317 }],
    ["*:8317", "IPv6", { address: "::", port: 8317 }],
  ])("%s on %s", (name, family, endpoint) => {
    expect(lsofEndpoint(name, family)).toEqual(endpoint);
  });
});
