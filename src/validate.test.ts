import assert from "node:assert/strict";
import { test } from "node:test";
import { clipTitle, findSecret } from "./validate.ts";

test("finds common secrets", () => {
  assert.equal(findSecret("key AKIAABCDEFGHIJKLMNOP here"), "AWS access key");
  assert.equal(findSecret(`use ghp_${"a".repeat(36)}`), "GitHub token");
  assert.equal(findSecret(`sk-ant-${"x".repeat(30)}`), "API key");
  assert.equal(
    findSecret("postgres://admin:hunter22@db:5432/app"),
    "credentials in URL",
  );
  assert.equal(
    findSecret("set PASSWORD=hunter22 in .env"),
    "secret assignment",
  );
  assert.equal(
    findSecret("-----BEGIN OPENSSH PRIVATE KEY-----"),
    "private key",
  );
});

test("allows placeholders and prose", () => {
  assert.equal(findSecret("set PASSWORD=<REDACTED> in .env"), undefined);
  assert.equal(findSecret("api_key: $OPENAI_API_KEY"), undefined);
  assert.equal(findSecret("token: ${GITHUB_TOKEN}"), undefined);
  assert.equal(findSecret("rotate the token every week"), undefined);
  assert.equal(findSecret("postgres://localhost:5432/app"), undefined);
});

test("clipTitle leaves short titles alone", () => {
  assert.deepEqual(clipTitle("Use  pnpm"), { title: "Use pnpm", clipped: false });
});

test("clipTitle shortens long titles at a word boundary", () => {
  const r = clipTitle("word ".repeat(40));
  assert.ok(r.title.length <= 120);
  assert.ok(r.title.endsWith("…"));
  assert.equal(r.clipped, true);
});
