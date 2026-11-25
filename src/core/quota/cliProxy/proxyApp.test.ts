import { describe, expect, it } from "vitest";
import {
  addressIsProxy,
  createProxyAppReader,
  lsofEndpoint,
  lsofListening,
  readProxySettings,
} from "./proxyApp";

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
      origins: ["http://127.0.0.1:8317"],
      port: 8317,
      key: "Mk7q2Vz9Lp4X",
      clientKey: "sk-client-one",
    });
  });

  // The live proof on a real install: EasyCLIProxyAPI writes its client keys
  // as inline tables with a remark beside each key.
  it("reads the first client key from the app's list of keys with remarks", () => {
    const tables = SETTINGS.replace(
      'api-keys = ["sk-client-one", "sk-client-two"]',
      'api-keys = [{ key = "sk-client-one", remark = "Claude Code" }, { key = "sk-client-two", remark = "Codex" }]',
    );
    expect(readProxySettings(tables)?.clientKey).toBe("sk-client-one");
  });

  it("reads the key field alone when a remark holds braces or key-like text", () => {
    const tables = SETTINGS.replace(
      'api-keys = ["sk-client-one", "sk-client-two"]',
      'api-keys = [{ remark = "old, key = \\"sk-remark\\" }", key = "sk-client-one" }, { key = "sk-client-two", remark = "{Codex}" }]',
    );
    expect(readProxySettings(tables)?.clientKey).toBe("sk-client-one");
  });

  it("reads key tables only when commas separate them, a trailing comma allowed", () => {
    const listed = (list: string) =>
      readProxySettings(
        SETTINGS.replace('api-keys = ["sk-client-one", "sk-client-two"]', `api-keys = ${list}`),
      )?.clientKey;
    expect(listed('[{ key = "sk-client-one" }, { key = "sk-client-two" },]')).toBe("sk-client-one");
    expect(listed('[{ key = "sk-client-one" } { key = "sk-client-two" }]')).toBe(undefined);
  });

  it("reads no client key when a table in the list has no key", () => {
    const tables = SETTINGS.replace(
      'api-keys = ["sk-client-one", "sk-client-two"]',
      `api-keys = [{ remark = "old, key = 'sk-remark', retired" }, { key = "sk-client-two", remark = "Codex" }]`,
    );
    const read = readProxySettings(tables);
    expect(read?.key).toBe("Mk7q2Vz9Lp4X");
    expect(read?.clientKey).toBe(undefined);
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

// The review's finding: an address is the proxy's only at a loopback
// origin the proxy itself listens on, so another service on the same port
// of the other loopback family never takes the proxy's reads or meters.
describe("addressIsProxy", () => {
  const IPV4 = ["http://127.0.0.1:8317"];
  const BOTH = ["http://127.0.0.1:8317", "http://[::1]:8317"];
  it.each([
    ["http://127.0.0.1:8317", IPV4, true],
    ["http://127.0.0.1:8317/v1", BOTH, true],
    ["http://[::1]:8317", IPV4, false],
    ["http://[::1]:8317/v1", BOTH, true],
    ["http://localhost:8317/v1", IPV4, false],
    ["http://localhost:8317/v1", BOTH, true],
    ["https://127.0.0.1:8317", IPV4, false],
    ["http://127.0.0.1:8318", IPV4, false],
    ["http://proxy.example.com:8317", IPV4, false],
    ["not an address", IPV4, false],
  ])("%s goes to a proxy listening at %j: %s", (address, origins, expected) => {
    expect(addressIsProxy(address, origins)).toBe(expected);
  });
});

describe("createProxyAppReader", () => {
  const PROGRAM = "C:\\Tools\\EasyCLIProxyAPI\\cli-proxy-api.exe";

  // EasyCLIProxyAPI keeps its settings in its own folder and runs the proxy
  // program from `cpa-core` inside it, as its Windows download lays them out.
  it("reads the app's settings from the folder above the proxy program", async () => {
    const reads: string[] = [];
    const reader = createProxyAppReader(
      async () => [
        {
          program: "C:\\Tools\\EasyCLIProxyAPI\\cpa-core\\cli-proxy-api.exe",
          endpoints: [{ address: "127.0.0.1", port: 8317 }],
        },
      ],
      async (path) => {
        reads.push(path.replaceAll("\\", "/"));
        if (path.includes("cpa-core")) throw new Error("ENOENT");
        return SETTINGS;
      },
    );
    expect(await reader()).toMatchObject({
      origin: "http://127.0.0.1:8317",
      origins: ["http://127.0.0.1:8317"],
    });
    expect(reads).toEqual([
      "C:/Tools/EasyCLIProxyAPI/cpa-core/config.toml",
      "C:/Tools/EasyCLIProxyAPI/config.toml",
    ]);
  });

  // The review's finding: the key comes from the settings the running proxy
  // uses; two files naming its port with different keys leave that unknown.
  describe("with settings both beside the proxy program and in the folder above", () => {
    const CORE = "C:\\Tools\\EasyCLIProxyAPI\\cpa-core\\cli-proxy-api.exe";
    const readerWith = (beside: string, above: string, ports = [8317]) =>
      createProxyAppReader(
        async () => [
          { program: CORE, endpoints: ports.map((port) => ({ address: "127.0.0.1", port })) },
        ],
        async (path) => (path.includes("cpa-core") ? beside : above),
      );

    it("reads nothing when both name the proxy's port with different keys", async () => {
      const stale = SETTINGS.replace("Mk7q2Vz9Lp4X", "Old4Key9Left");
      expect(await readerWith(stale, SETTINGS)()).toBe(undefined);
      expect(await readerWith(SETTINGS, stale)()).toBe(undefined);
    });

    it("reads nothing when both hold the same keys for two ports the proxy listens on", async () => {
      const other = SETTINGS.replace("port = 8317", "port = 8400");
      expect(await readerWith(other, SETTINGS, [8317, 8400])()).toBe(undefined);
      expect(await readerWith(SETTINGS, other, [8317, 8400])()).toBe(undefined);
    });

    it("reads the one that names the port the proxy listens on", async () => {
      const other = SETTINGS.replace("port = 8317", "port = 8400").replace(
        "Mk7q2Vz9Lp4X",
        "Old4Key9Left",
      );
      expect(await readerWith(other, SETTINGS)()).toMatchObject({ key: "Mk7q2Vz9Lp4X" });
      expect(await readerWith(SETTINGS, other)()).toMatchObject({ key: "Mk7q2Vz9Lp4X" });
    });

    it("reads them when both hold the same keys", async () => {
      expect(await readerWith(SETTINGS, SETTINGS)()).toMatchObject({ key: "Mk7q2Vz9Lp4X" });
    });
  });

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
    expect(await reader()).toMatchObject({
      origin: "http://127.0.0.1:8317",
      origins: ["http://127.0.0.1:8317", "http://[::1]:8317"],
    });
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

  // The review's finding: where a wildcard answers is not guessed.
  it.each([undefined, "unix", "sock"])(
    "names no endpoint for a wildcard of family %s",
    (family) => {
      expect(lsofEndpoint("*:8317", family)).toBe(undefined);
    },
  );
});

describe("lsofListening", () => {
  // The review's finding: a file's family never carries over to the next
  // file or process.
  it("reads each file's wildcard by its own family alone", () => {
    const lines = ["p100", "f5", "tIPv6", "n*:8317", "f6", "n*:8318", "p200", "f3", "n*:8319"];
    expect([...lsofListening(lines)]).toEqual([["100", [{ address: "::", port: 8317 }]]]);
  });
});
