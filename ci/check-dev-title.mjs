import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCase } from "../case.mjs";

// A storage-boundary rehearsal only. No CLI, provider identity, or real evidence.
const work = await mkdtemp(join(tmpdir(), "fieldnote-artifact-"));
const source = fileURLToPath(new URL("cloud.mjs", import.meta.url));
const key = randomBytes(32).toString("base64");
const settings = {
  CASE_WORK: work, RUNNER_TEMP: work,
  GITHUB_RUN_ID: "123", APPROVED_DEV_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: "a".repeat(40), APPROVED_SHA: "a".repeat(40),
  APPROVED_STAGE: "dev-title", ZERO_CHARGE: "confirmed", VERIFICATION_EVIDENCE_KEY: key,
};
if (process.env.SystemRoot) settings.SystemRoot = process.env.SystemRoot;
function check(command, expected, overrides = {}) {
  const result = spawnSync(process.execPath, [source, command, "dev-title"], {
    env: { ...settings, ...overrides }, stdio: "pipe", timeout: 15000,
  });
  assert.equal(result.status, expected, command);
}
try {
  check("prepare", 0);
  for (const override of [
    { APPROVED_DEV_RUN_ID: "124" }, { GITHUB_RUN_ATTEMPT: "2" },
    { APPROVED_SHA: "b".repeat(40) }, { APPROVED_STAGE: "title" },
    { ZERO_CHARGE: "" }, { VERIFICATION_EVIDENCE_KEY: "" },
  ]) check("prepare", 1, override);
  await writeFile(join(work, "identity"), JSON.stringify({ authenticated: true, balance: 0 }));
  check("admission", 1);
  await writeFile(join(work, "identity"), JSON.stringify({ authenticated: true, balance: 1 }));
  check("admission", 0);
  check("admission", 1);
  check("admission", 1, { APPROVED_DEV_RUN_ID: "124" });
  // A missing native pack must produce an encrypted diagnostic and fail the job.
  check("settle", 1);
  const ciphertext = await readFile(join(work, "fieldnote-title.case"));
  process.env.VERIFICATION_EVIDENCE_KEY = key;
  const diagnostic = openCase(ciphertext);
  assert.equal(diagnostic.result, "inconclusive");
  assert.equal(diagnostic.evidence, null);
  assert.equal(diagnostic.run, settings.GITHUB_RUN_ID);
  check("settle", 1);
  assert.deepEqual(await readFile(join(work, "fieldnote-title.case")), ciphertext);
  const altered = Buffer.from(ciphertext);
  altered[altered.length - 1] ^= 1;
  assert.throws(() => openCase(altered));
  process.env.VERIFICATION_EVIDENCE_KEY = randomBytes(32).toString("base64");
  assert.throws(() => openCase(ciphertext));
  if (process.env.RUNNER_TEMP) await writeFile(join(process.env.RUNNER_TEMP, "fieldnote-title.case"), ciphertext, { flag: "wx", mode: 0o600 });
  console.log("Development admission, replay denial, encrypted diagnostic retention and tamper detection passed.");
} finally {
  await rm(work, { recursive: true, force: true });
}
