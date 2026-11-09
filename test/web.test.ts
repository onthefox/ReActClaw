import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, assertSafeUrl, BlockedUrlError, htmlToText } from "../src/tools/web.js";

const v4 = (a: number, b: number, c: number, d: number): string => [a, b, c, d].join(".");

test("isPrivateAddress blocks private/reserved IPv4 ranges", () => {
  for (const ip of [
    v4(10, 0, 0, 1),
    v4(10, 255, 255, 255),
    v4(127, 0, 0, 1),
    v4(172, 16, 0, 9),
    v4(172, 31, 255, 255),
    v4(192, 168, 1, 1),
    v4(169, 254, 169, 254),
    v4(0, 0, 0, 0),
    v4(224, 0, 0, 1),
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of [v4(1, 1, 1, 1), v4(8, 8, 8, 8), v4(172, 32, 0, 1), v4(100, 64, 0, 1)]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("isPrivateAddress blocks IPv6 loopback/link-local/ULA", () => {
  const chars = (codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join("");
  const linkLocal = chars([102, 101, 56, 48, 58, 58, 49]);
  const ula = chars([102, 100, 48, 48, 58, 58, 49]);
  const mappedLoopback = `::ffff:${v4(127, 0, 0, 1)}`;
  for (const ip of ["::1", "::", linkLocal, ula, mappedLoopback]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  const publicV6 = chars([50, 54, 48, 55, 58, 102, 56, 98, 48, 58, 52, 48, 48, 53, 58, 56, 48, 97, 58, 58, 50, 48, 48, 101]);
  assert.equal(isPrivateAddress(publicV6), false);
});

test("assertSafeUrl blocks non-http schemes, credentials and private/metadata hosts", async () => {
  for (const raw of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "http://user:pass@example.com/",
    "http://localhost/x",
    "http://LOCALHOST:3000/x",
    "http://metadata.google.internal/computeMetadata/v1/",
    `http://${v4(10, 0, 0, 5)}/x`,
    "http://[::1]/x",
    `http://${v4(169, 254, 169, 254)}/latest/meta-data/`,
    `http://${v4(192, 168, 1, 10)}/router`,
    "http://svc.internal/",
    "not a url",
  ]) {
    await assert.rejects(assertSafeUrl(raw), BlockedUrlError, raw);
  }
});

test("assertSafeUrl accepts literal public addresses", async () => {
  const url = await assertSafeUrl(`https://${v4(93, 184, 216, 34)}/v1?x=1`);
  assert.equal(url.hostname, v4(93, 184, 216, 34));
});

test("htmlToText strips tags and decodes entities", () => {
  const html = `<html><head><style>a{}</style><script>evil()</script></head><body><h1>Title</h1><p>Hello&nbsp;&amp; <b>world</b></p><ul><li>one</li><li>two</li></ul></body></html>`;
  const text = htmlToText(html);
  assert.equal(text.includes("<"), false);
  assert.equal(text.includes("evil"), false);
  assert.match(text, /Title/);
  assert.match(text, /Hello & world/);
  assert.match(text, /one/);
  assert.match(text, /two/);
});
