/**
 * `gemini-code serve` under real client behaviour: disconnects, a bounded
 * queue, safe image fetching, and errors mid-stream. A fake driver whose
 * replies are held until the test releases (or Stops) them, real HTTP on
 * 127.0.0.1, and a fake resolver — no browser, no internet. Called from smoke.ts.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "../server/openai.js";
import { fetchImage, isBlockedAddress, redactUrl, sniffImage } from "../server/imageFetch.js";

type Test = (name: string, fn: () => Promise<void> | void) => Promise<void>;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

/** A tab whose reply only finishes when released or stopped. */
function gatedDriver() {
  let open: (() => void) | undefined;
  let gate = Promise.resolve();
  const d = {
    prompts: [] as string[],
    attached: [] as string[][],
    newConversationCalls: 0,
    stopCalls: 0,
    failMidStream: false,
    hold() {
      gate = new Promise<void>((r) => (open = r));
    },
    release() {
      open?.();
    },
    async newConversation() {
      d.newConversationCalls++;
    },
    async setModel(a: string) {
      return a;
    },
    async sendPrompt(text: string, o: { attachFile?: string[] } = {}) {
      d.prompts.push(text);
      d.attached.push(o.attachFile ?? []);
    },
    async stopGenerating() {
      d.stopCalls++;
      open?.();
      return true;
    },
    async waitForResponseComplete() {
      await gate;
    },
    async streamResponse(on: (md: string) => void) {
      on("first line\n");
      if (d.failMidStream) throw new Error("the tab crashed");
      await gate;
      on("first line\nsecond line");
    },
    async getLastResponse() {
      return { text: "first line\nsecond line", codeBlocks: [] };
    },
    async getLastResponseMarkdown() {
      return "first line\nsecond line";
    },
    async spawnTab() {
      throw new Error("one tab");
    },
    async close() {},
  };
  return d;
}

async function serve(extra: Partial<Parameters<typeof startServer>[0]> = {}) {
  const driver = gatedDriver();
  const port = 20000 + Math.floor(Math.random() * 5000);
  const server = await startServer({ driver: driver as never, host: "127.0.0.1", port, tabs: 1, allowedOrigins: [], log: () => {}, ...extra });
  return { driver, server, base: `http://127.0.0.1:${port}` };
}

const chat = (base: string, body: Record<string, unknown>, signal?: AbortSignal) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }),
    signal,
  });

/** A local HTTP server that counts requests. */
async function localServer(handler: http.RequestListener) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { port, hits: () => hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const imageMessage = (url: string) => ({ messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url } }] }] });

export async function apiServerTests(test: Test): Promise<void> {
  await test("serve: a streaming client that aborts mid-reply stops Gemini and frees the tab", async () => {
    const { driver, server, base } = await serve();
    try {
      driver.hold();
      const ac = new AbortController();
      const res = await chat(base, { stream: true }, ac.signal);
      const reader = res.body!.getReader();
      await reader.read(); // the first chunk arrived: Gemini is "writing"
      ac.abort();
      assert.ok(await until(() => driver.stopCalls > 0), "Stop was pressed");
      const started = Date.now();
      const next = await chat(base, {});
      assert.equal(next.status, 200);
      assert.ok(Date.now() - started < 3000, "the next request got the tab quickly");
      assert.equal(driver.newConversationCalls, 2, "the next request started a fresh thread");
    } finally {
      await server.close();
    }
  });

  await test("serve: a non-streaming client that closes while waiting frees the tab the same way", async () => {
    const { driver, server, base } = await serve();
    try {
      driver.hold();
      const ac = new AbortController();
      const pending = chat(base, {}, ac.signal).catch(() => undefined);
      assert.ok(await until(() => driver.prompts.length === 1));
      ac.abort();
      await pending;
      assert.ok(await until(() => driver.stopCalls > 0));
      const next = await chat(base, {});
      assert.equal(next.status, 200);
      assert.equal(driver.newConversationCalls, 2);
    } finally {
      await server.close();
    }
  });

  await test("serve: with every tab busy, a full queue gets 429 at once and a long wait 503, both with Retry-After", async () => {
    const { driver, server, base } = await serve({ maxQueue: 1, queueTimeoutMs: 400 });
    try {
      driver.hold();
      const first = chat(base, {});
      assert.ok(await until(() => driver.prompts.length === 1));
      const queued = chat(base, {}); // waits
      await sleep(50);
      const t0 = Date.now();
      const full = await chat(base, {});
      assert.equal(full.status, 429);
      assert.ok(Date.now() - t0 < 300, "refused at once, not after waiting");
      assert.equal(full.headers.get("retry-after"), "30");
      const body = await full.json();
      assert.equal(body.error.type, "rate_limit_error");
      assert.equal(body.error.code, "queue_full");

      const timedOut = await queued;
      assert.equal(timedOut.status, 503);
      assert.equal(timedOut.headers.get("retry-after"), "30");
      assert.equal((await timedOut.json()).error.code, "queue_timeout");
      assert.equal(timedOut.headers.get("x-should-retry"), null, "nothing reached Gemini, so retrying is fine");
      driver.release();
      assert.equal((await first).status, 200);
    } finally {
      await server.close();
    }
  });

  await test("serve: a queued client that disconnects never takes a tab; the next waiter gets it, in order", async () => {
    const { driver, server, base } = await serve({ maxQueue: 3 });
    try {
      driver.hold();
      const first = chat(base, { messages: [{ role: "user", content: "A" }] });
      assert.ok(await until(() => driver.prompts.length === 1));
      const ac = new AbortController();
      const leaver = chat(base, { messages: [{ role: "user", content: "B" }] }, ac.signal).catch(() => undefined);
      await sleep(50);
      const third = chat(base, { messages: [{ role: "user", content: "C" }] });
      await sleep(50);
      ac.abort();
      await leaver;
      await sleep(50);
      driver.release();
      assert.equal((await first).status, 200);
      assert.equal((await third).status, 200);
      assert.equal(driver.prompts.length, 2, "B was never sent");
      assert.match(driver.prompts[1], /C/);
    } finally {
      await server.close();
    }
  });

  await test("serve: a failure mid-stream sends exactly one error event, ends the stream, and resets the tab", async () => {
    const { driver, server, base } = await serve();
    try {
      driver.failMidStream = true;
      const res = await chat(base, { stream: true });
      const text = await res.text();
      assert.equal((text.match(/"error"/g) ?? []).length, 1, text);
      assert.ok(!text.includes("[DONE]"));
      driver.failMidStream = false;
      assert.equal((await chat(base, {})).status, 200);
      assert.equal(driver.newConversationCalls, 2, "the tab's thread was reset");
    } finally {
      await server.close();
    }
  });

  await test("serve: an error after the prompt reached Gemini says x-should-retry: false", async () => {
    const { driver, server, base } = await serve();
    try {
      driver.waitForResponseComplete = async () => {
        throw new Error("Gemini went away");
      };
      const res = await chat(base, {});
      assert.equal(res.status, 500);
      assert.equal(res.headers.get("x-should-retry"), "false");
    } finally {
      await server.close();
    }
  });

  await test("images: private, local and special addresses are refused; public ones allowed", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::", "2001:db8::1"]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isBlockedAddress(ip), false, ip);
    assert.equal(sniffImage(PNG), "png");
    assert.equal(sniffImage(Buffer.from("<html>")), undefined);
    assert.equal(redactUrl("https://user:pass@img.example/a.png"), "https://***@img.example/a.png");
  });

  await test("images: 127.0.0.1, ::1, 10.x and 169.254.169.254 are refused before any connection", async () => {
    const internal = await localServer((_req, res) => res.end(PNG));
    const { driver, server, base } = await serve();
    try {
      for (const url of [`http://127.0.0.1:${internal.port}/a.png`, "http://[::1]/a.png", "http://10.0.0.5/a.png", "http://169.254.169.254/latest/meta-data"]) {
        const res = await chat(base, imageMessage(url));
        assert.equal(res.status, 400, url);
        assert.match((await res.json()).error.message, /private or local/);
      }
      assert.equal(internal.hits(), 0, "no connection was made");
      assert.equal(driver.prompts.length, 0, "nothing was sent to Gemini");
      assert.equal(driver.newConversationCalls, 0, "a refused image doesn't touch the tab");
    } finally {
      await server.close();
      await internal.close();
    }
  });

  await test("images: a public-looking name that resolves to loopback, or to a mixed answer, is refused", async () => {
    const internal = await localServer((_req, res) => res.end(PNG));
    const resolve = async (host: string) =>
      host === "evil.example" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }];
    try {
      await assert.rejects(fetchImage(`http://evil.example:${internal.port}/a.png`, { resolve }), /127\.0\.0\.1, a private or local address/);
      await assert.rejects(fetchImage(`http://mixed.example/a.png`, { resolve }), /10\.0\.0\.7/);
      assert.equal(internal.hits(), 0);
    } finally {
      await internal.close();
    }
  });

  // A "public" host (93.184.216.34 by the fake resolver) actually served locally.
  const asPublic = (port: number) => ({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    dialOverride: (a: string) => (a === "93.184.216.34" ? { address: "127.0.0.1", family: 4, port } : undefined),
  });

  await test("images: a public image is fetched; a redirect to a refused address is stopped at the hop", async () => {
    const internal = await localServer((_req, res) => res.end(PNG));
    const pub = await localServer((req, res) => {
      if (req.url === "/ok.png") return res.end(PNG);
      res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/secret` });
      res.end();
    });
    try {
      const ok = await fetchImage("http://img.example/ok.png", asPublic(pub.port));
      assert.equal(ok.ext, "png");
      await assert.rejects(fetchImage("http://img.example/redirect", asPublic(pub.port)), /private or local/);
      assert.equal(internal.hits(), 0, "the internal server was never reached");
    } finally {
      await internal.close();
      await pub.close();
    }
  });

  await test("images: at most 3 redirects", async () => {
    const pub = await localServer((req, res) => {
      const n = Number(req.url?.slice(1) || 0);
      res.writeHead(302, { Location: `/${n + 1}` });
      res.end();
    });
    try {
      await assert.rejects(fetchImage("http://img.example/0", asPublic(pub.port)), /more than 3 redirects/);
      assert.equal(pub.hits(), 4);
    } finally {
      await pub.close();
    }
  });

  await test("images: an over-limit body stops downloading just past the limit; a compressed one is refused", async () => {
    let written = 0;
    let gzipAsked = "";
    const pub = await localServer((req, res) => {
      if (req.url === "/gz") {
        gzipAsked = String(req.headers["accept-encoding"]);
        res.writeHead(200, { "Content-Encoding": "gzip" });
        return res.end(Buffer.alloc(10));
      }
      res.writeHead(200, { "Content-Type": "image/png" }); // no Content-Length
      const chunk = Buffer.alloc(64 * 1024);
      const pump = () => {
        while (written < 50 * 1024 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("close", () => undefined);
      pump();
    });
    try {
      await assert.rejects(fetchImage("http://img.example/big", { ...asPublic(pub.port), maxBytes: 256 * 1024 }), /over the .* limit/);
      await sleep(100);
      assert.ok(written < 8 * 1024 * 1024, `the server only got to write ${written} bytes before the hang-up`);
      await assert.rejects(fetchImage("http://img.example/gz", asPublic(pub.port)), /compressed/);
      assert.equal(gzipAsked, "identity");
    } finally {
      await pub.close();
    }
  });

  await test("images: a body that isn't an image is refused, whatever its Content-Type says", async () => {
    const pub = await localServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end("<html>not an image</html>");
    });
    try {
      await assert.rejects(fetchImage("http://img.example/x.png", asPublic(pub.port)), /isn't a PNG, JPEG, GIF or WebP/);
    } finally {
      await pub.close();
    }
  });

  await test("images: --remote-images off refuses http(s) but data: URLs still work", async () => {
    const { driver, server, base } = await serve({ remoteImages: false });
    try {
      const remote = await chat(base, imageMessage("https://img.example/a.png"));
      assert.equal(remote.status, 400);
      assert.match((await remote.json()).error.message, /turned off/);
      const data = await chat(base, imageMessage(`data:image/png;base64,${PNG.toString("base64")}`));
      assert.equal(data.status, 200);
      assert.equal(driver.attached[0].length, 1);
    } finally {
      await server.close();
    }
  });

  await test("images: a client disconnecting mid-download cancels it and frees the tab; nothing is sent", async () => {
    let started = false;
    const slow = await localServer((_req, res) => {
      started = true;
      res.writeHead(200);
      res.write(PNG); // then never finishes
    });
    const { driver, server, base } = await serve({ imageFetch: asPublic(slow.port) });
    try {
      const ac = new AbortController();
      const pending = chat(base, imageMessage("http://img.example/slow.png"), ac.signal).catch(() => undefined);
      assert.ok(await until(() => started));
      ac.abort();
      await pending;
      assert.equal((await chat(base, {})).status, 200, "the tab is free");
      assert.equal(driver.prompts.length, 1, "only the second request reached Gemini");
    } finally {
      await server.close();
      await slow.close();
    }
  });
}
