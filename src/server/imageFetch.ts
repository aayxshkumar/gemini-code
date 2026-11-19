/**
 * Fetching `image_url` http(s) URLs for the API, without letting a caller
 * use this machine to reach internal addresses or exhaust its memory.
 *
 *   - Every hop is resolved first, and refused if ANY address is private,
 *     local or special (loopback, RFC 1918, link-local and cloud metadata,
 *     CGNAT, multicast, documentation ranges, IPv4-mapped / NAT64 / 6to4
 *     IPv6 forms of those). An IP literal is checked the same way.
 *   - The connection goes to exactly the address that was checked — no
 *     second DNS lookup for a rebinding trick to answer — while HTTPS still
 *     verifies the certificate against the host name.
 *   - At most 3 redirects, each hop checked again.
 *   - `Accept-Encoding: identity`, and a compressed body is refused (a
 *     small gzip can inflate to gigabytes).
 *   - Bytes are counted as they arrive and the download stops just past
 *     the limit; a Content-Length over the limit is refused before reading.
 *   - One deadline for all of a request's images, and the client hanging up
 *     aborts the download.
 *   - The body must start like a PNG, JPEG, GIF or WebP, whatever the
 *     Content-Type says.
 *
 * Remote images can be turned off (data: URLs still work), and private
 * hosts allowed for a local setup that really serves images on 10.x.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const IMAGE_DEADLINE_MS = 30_000;

export class ImageFetchError extends Error {}

export interface ImageFetchOptions {
  /** Allow hosts on private/local addresses (default false). */
  allowPrivate?: boolean;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Test seams. */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Extra CA for HTTPS (tests' self-signed fixture). */
  ca?: string | Buffer;
  /** Called with each address actually dialled (tests count hits on it). */
  onDial?: (address: string, host: string) => void;
  /**
   * Tests only: where a checked address is really connected — lets a fake
   * "public" address reach a local test server. The CHECK still uses the
   * address as resolved.
   */
  dialOverride?: (address: string) => { address: string; family: number; port?: number } | undefined;
}

/** user:pass@ never reaches an error message or a log. */
export function redactUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]*@/i, "$1***@");
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Expands an IPv6 address to its eight 16-bit groups. */
function v6Groups(ip: string): number[] | undefined {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    text = text.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined;
}

const groupsToV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** Is this address one an API caller must not make us connect to? */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Blocked(ip);
  const g = v6Groups(ip);
  if (!g) return true; // unparseable: refuse
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && g[7] === 1) return true; // ::1
  if (allZero(0, 5) && g[5] === 0xffff) return v4Blocked(groupsToV4(g[6], g[7])); // ::ffff:a.b.c.d
  if (allZero(0, 6)) return true; // ::a.b.c.d (deprecated compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return v4Blocked(groupsToV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return v4Blocked(groupsToV4(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x0100 && allZero(1, 4)) return true; // discard-only
  return false;
}

/** The format from the first bytes, or undefined if it isn't an image Gemini takes. */
export function sniffImage(head: Buffer): "png" | "jpg" | "gif" | "webp" | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return undefined;
}

async function resolveHost(host: string, opts: ImageFetchOptions): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(bare)
    ? [{ address: bare, family: net.isIP(bare) }]
    : await (opts.resolve ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true })))(bare).catch((err: Error) => {
        throw new ImageFetchError(`can't resolve ${bare}: ${err.message}`);
      });
  if (!addresses.length) throw new ImageFetchError(`${bare} has no addresses`);
  if (!opts.allowPrivate) {
    // ALL of them: a mixed answer is how a name points at both a public
    // decoy and the internal target.
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) throw new ImageFetchError(`${bare} resolves to ${bad.address}, a private or local address — refused`);
  }
  return addresses[0];
}

/** One hop: a status, maybe a Location, and a body stream. */
function request(url: URL, checked: { address: string; family: number }, opts: ImageFetchOptions, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const override = opts.dialOverride?.(checked.address);
    const target = override ? { address: override.address, family: override.family } : checked;
    const lookup: LookupFunction = (_host, options, cb) => {
      // Always the checked address, never a fresh lookup.
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [target]);
      else cb(null, target.address, target.family);
    };
    opts.onDial?.(checked.address, url.hostname);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        ...(override?.port ? { port: override.port } : {}),
        method: "GET",
        lookup,
        signal,
        agent: false,
        headers: { "Accept-Encoding": "identity", Accept: "image/png,image/jpeg,image/gif,image/webp", "User-Agent": "gemini-code-api" },
        ...(url.protocol === "https:" ? { servername: url.hostname.replace(/^\[|\]$/g, ""), ...(opts.ca ? { ca: opts.ca } : {}) } : {}),
      },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

/** Fetches one image URL safely. Returns its bytes and format. */
export async function fetchImage(rawUrl: string, opts: ImageFetchOptions = {}): Promise<{ data: Buffer; ext: string }> {
  const max = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const signal = opts.signal ?? new AbortController().signal;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageFetchError("not a valid URL");
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ImageFetchError(`${url.protocol} URLs aren't fetched`);
    const target = await resolveHost(url.hostname, opts);
    if (signal.aborted) throw new ImageFetchError("cancelled");
    const res = await request(url, target, opts, signal).catch((err: Error) => {
      throw new ImageFetchError(signal.aborted ? "cancelled" : err.message);
    });
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new ImageFetchError(`more than ${MAX_REDIRECTS} redirects`);
      url = new URL(res.headers.location, url);
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new ImageFetchError(`HTTP ${res.statusCode}`);
    }
    const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
    if (encoding !== "identity") {
      res.destroy();
      throw new ImageFetchError(`compressed responses (${encoding}) aren't accepted`);
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      res.destroy();
      throw new ImageFetchError(`over the ${Math.round(max / 1024 / 1024)} MB limit (${declared} bytes declared)`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        total += chunk.length;
        // Never more than the cap, or than the server said it would send.
        if (total > max || (Number.isFinite(declared) && total > declared)) {
          res.destroy();
          throw new ImageFetchError(`over the ${Math.round(max / 1024 / 1024)} MB limit`);
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof ImageFetchError) throw err;
      throw new ImageFetchError(signal.aborted ? "cancelled" : (err as Error).message);
    }
    const data = Buffer.concat(chunks);
    const ext = sniffImage(data);
    if (!ext) throw new ImageFetchError("the response isn't a PNG, JPEG, GIF or WebP image");
    return { data, ext };
  }
}
