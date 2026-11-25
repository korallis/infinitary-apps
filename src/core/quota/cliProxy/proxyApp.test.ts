import { describe, expect, it } from "vitest";
import { addressIsProxy, createProxyAppReader, readProxySettings } from "./proxyApp";

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
  it("looks for the running proxy once, then reads its settings file each time", async () => {
    let finds = 0;
    const reads: string[] = [];
    const reader = createProxyAppReader(
      async () => {
        finds += 1;
        return ["C:\\Tools\\EasyCLIProxyAPI\\EasyCLIProxyAPI.exe"];
      },
      async (path) => {
        reads.push(path);
        return SETTINGS;
      },
    );
    expect((await reader())?.port).toBe(8317);
    expect((await reader())?.port).toBe(8317);
    expect(finds).toBe(1);
    expect(reads).toHaveLength(2);
    expect(reads[0]?.replaceAll("\\", "/")).toBe("C:/Tools/EasyCLIProxyAPI/config.toml");
  });

  it("asks the process list again only after the wait while no proxy runs", async () => {
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
