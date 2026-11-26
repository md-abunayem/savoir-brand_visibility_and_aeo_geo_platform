import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { page, faqObjective, digest } from "./fixture.mjs";

const domain = Buffer.from("Fieldnote private case v1");
const baseline = digest(page("initial"));
const corrected = digest(page("approved"));
const objective = digest(faqObjective);
function key() {
  const encoded = process.env.VERIFICATION_EVIDENCE_KEY || "";
  const bytes = Buffer.from(encoded, "base64");
  assert.ok(
    bytes.length === 32 && bytes.toString("base64") === encoded,
    "A dedicated 32-byte case key is required",
  );
  return bytes;
}
export function seal(record) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(domain);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(record), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}
export function openCase(bytes) {
  assert.ok(bytes.length > 28 && bytes.length < 40 * 1024 * 1024);
  const cipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
  cipher.setAAD(domain);
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]),
  );
}
export function requireBefore(record) {
  assert.equal(record.stage, "faq-before");
  assert.equal(record.result, "observed-defect");
  assert.equal(record.revision, baseline);
  assert.equal(record.objective, objective);
  assert.equal(record.observed, "missing");
  assert.ok(
    record.evidence.failedStep &&
      record.evidence.screenshots.length &&
      Number.isFinite(record.credits) &&
      record.credits >= 0,
  );
  assert.equal(digest(Buffer.from(record.pack, "base64")), record.packHash);
}
export function requireApproval(record) {
  assert.equal(record.stage, "approved");
  assert.equal(record.proposal.stage, "proposal");
  assert.equal(record.proposal.operation, "open-native-disclosure");
  assert.equal(record.proposal.child, corrected);
  requireBefore(record.proposal.before);
  assert.equal(record.approvedHash, digest(JSON.stringify(record.proposal)));
}

async function propose(before) {
  requireBefore(before);
  assert.equal(
    process.env.FREE_MODEL_APPROVED,
    "yes",
    "Confirm the zero-charge model allowance",
  );
  const model = process.env.GEMINI_MODEL;
  assert.ok(
    /^gemini-[a-z0-9.-]+$/.test(model || "") && process.env.GEMINI_API_KEY,
  );
  // Only project-owned synthetic facts and image hashes are sent. The private pack stays local.
  const facts = {
    observed: before.observed,
    expected: "a visible envelope return instruction",
    imageHashes: before.evidence.screenshots,
    control: "inert button beside a hidden paragraph",
    permitted: ["open-native-disclosure", "manual-review"],
  };
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  "Using this observed evidence, choose one permitted operation. Return a JSON object with only operation. " +
                  JSON.stringify(facts),
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 512,
        },
      }),
    },
  );
  assert.ok(
    response.ok,
    "Model request failed. Review its usage before any further approval.",
  );
  const reply = await response.json();
  const choice = JSON.parse(
    reply.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("") ||
      "null",
  );
  assert.deepEqual(Object.keys(choice), ["operation"]);
  assert.ok(facts.permitted.includes(choice.operation));
  return {
    stage: "proposal",
    before,
    model,
    operation: choice.operation,
    child: corrected,
    inputHash: digest(JSON.stringify(facts)),
    usage: reply.usageMetadata ?? null,
  };
}

async function main() {
  const [command, input, output] = process.argv.slice(2);
  const inputBytes = await readFile(input);
  const record = openCase(inputBytes);
  if (command === "compare") {
    requireApproval(record);
    const after = openCase(await readFile(output));
    const before = record.proposal.before;
    assert.equal(after.stage, "faq-after");
    assert.equal(after.result, "verified");
    assert.equal(after.parent.hash, digest(inputBytes));
    assert.equal(after.objective, before.objective);
    assert.equal(after.revision, record.proposal.child);
    assert.equal(after.sha, before.sha);
    assert.ok(after.evidence.screenshots.length);
    const publicRun = (r) => ({
      result: r.result,
      revision: r.revision,
      screenshotCount: r.evidence.screenshots.length,
      packHash: r.packHash,
      reportedCredits: r.credits,
    });
    console.log(
      JSON.stringify(
        {
          objective: before.objective,
          before: publicRun(before),
          after: publicRun(after),
          model: record.proposal.model,
          approval: record.approvedHash,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "inspect") {
    console.log(
      JSON.stringify(
        {
          stage: record.stage,
          result: record.result,
          observed: record.observed,
          executionId: record.executionId,
          terminalStatus: record.status,
          resultCode: record.resultCode,
          reason: record.reason,
          providerErrors: record.errors,
          credits: record.credits,
          revision: record.revision,
          objective: record.objective,
          packHash: record.packHash,
          evidence: record.evidence,
          operation: record.operation,
          model: record.model,
          usage: record.usage,
          accountBalance: record.balance ?? record.initialBalance,
          remainingBalance: record.remainingBalance,
          resultCode: record.resultCode,
          reason: record.reason,
          exitCode: record.code,
          parent: record.parent,
          approvedHash: record.approvedHash,
        },
        null,
        2,
      ),
    );
    return;
  }
  assert.ok(output);
  let next;
  if (command === "propose") {
    requireBefore(record);
    assert.ok(
      process.env.FREE_MODEL_APPROVED === "yes" &&
        process.env.GEMINI_API_KEY &&
        /^gemini-[a-z0-9.-]+$/.test(process.env.GEMINI_MODEL || ""),
    );
    try {
      await readFile(output);
      throw Error("Proposal output exists");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    // Durable admission in this case directory survives a crash or lost model response.
    await writeFile(input + ".model-admitted", digest(JSON.stringify(record)), {
      flag: "wx",
      mode: 0o600,
    });
    next = await propose(record);
  } else if (command === "approve") {
    assert.equal(record.stage, "proposal");
    requireBefore(record.before);
    assert.equal(record.operation, "open-native-disclosure");
    assert.ok(process.stdin.isTTY, "Human terminal required");
    const hash = digest(JSON.stringify(record));
    console.log(
      "Model:",
      record.model,
      "\nEvidence:",
      record.before.packHash,
      "\nChange: replace the inert return question with a native disclosure containing the original answer.",
      "\nCurrent revision:",
      baseline,
      "\nProposed revision:",
      corrected,
    );
    const reader = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      assert.equal(
        await reader.question(
          "Type APPROVE " + hash.slice(0, 12) + " to accept this revision: ",
        ),
        "APPROVE " + hash.slice(0, 12),
      );
    } finally {
      reader.close();
    }
    next = {
      stage: "approved",
      proposal: record,
      approvedHash: hash,
      at: new Date().toISOString(),
    };
    requireApproval(next);
  } else throw Error("Use inspect, propose or approve");
  await writeFile(output, seal(next), { flag: "wx", mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Case operation stopped. Check the input, approval and private output path.",
    );
    process.exitCode = 1;
  });
