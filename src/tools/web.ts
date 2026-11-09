import * as net from "node:net";
import * as dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { AgentTool } from "../core/loop.js";

const MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata.goog"]);

export class BlockedUrlError extends Error {}

/** IPv4 in a private/reserved range, or IPv6 loopback/link-local/ULA. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((s) => Number.parseInt(s, 10));
    const [a = 0, b = 0] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice("::ffff:".length));
    return false;
  }
  return true;
}

/** SSRF guard: http/https only, no credentials, no private/loopback hosts. */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`protocol ${url.protocol} is not allowed`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new BlockedUrlError("credentials in URL are not allowed");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) throw new BlockedUrlError(`host ${host} is not allowed`);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedUrlError(`address ${host} is not allowed`);
    return url;
  }
  if (host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new BlockedUrlError(`host ${host} is not allowed`);
  }
  let records: LookupAddress[];
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`cannot resolve host ${host}`);
  }
  if (records.length === 0 || records.some((r) => isPrivateAddress(r.address))) {
    throw new BlockedUrlError(`host ${host} resolves to a forbidden address`);
  }
  return url;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webFetchTool: AgentTool = {
  name: "web_fetch",
  description:
    "Fetch a public URL (http/https only) and return its content as text: JSON as-is, HTML stripped to text. Max 256 KB.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL to fetch" } },
    required: ["url"],
  },
  async run(args) {
    const raw = args.url;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return { ok: false, output: "url is required" };
    }
    try {
      const url = await assertSafeUrl(raw);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal,
          headers: { "user-agent": "ReActClaw/0.1 (+web_fetch)" },
        });
      } finally {
        clearTimeout(timer);
      }
      const contentType = res.headers.get("content-type") ?? "";
      const text = (await res.text()).slice(0, MAX_BYTES);
      if (!res.ok) {
        return { ok: false, output: `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}` };
      }
      const body = contentType.includes("html") ? htmlToText(text) : text;
      return { ok: true, output: `HTTP ${res.status} ${contentType}\n\n${body}` };
    } catch (err) {
      if (err instanceof BlockedUrlError) return { ok: false, output: `blocked: ${err.message}` };
      return { ok: false, output: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
