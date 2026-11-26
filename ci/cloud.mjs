import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { openCase, seal, requireApproval } from "../case.mjs";
import {
  page,
  title,
  answer,
  titleObjective,
  faqObjective,
  digest,
} from "../fixture.mjs";

const execute = promisify(execFile);
const [command, operation] = process.argv.slice(2);
const developmentTitle = operation === "dev-title";
const hackathon = ["hack-title", "hack-faq-before", "hack-faq-after"].includes(operation);
const localArtifact = developmentTitle || hackathon;
const stage = developmentTitle ? "title" : hackathon ? operation.slice(5) : operation;
const live = ["title", "faq-before", "faq-after"].includes(stage);
const env = process.env;
const fixed = !hackathon && stage === "faq-after";
const objective = stage === "title" ? titleObjective : faqObjective;
const stageKey = "fieldnote-v1/";
const work = (name) => join(env.CASE_WORK, name);

// Only the trusted supervisor receives signed URLs or the encryption key.
function vaultUrl(variable, leaf) {
  const url = new URL(env[variable]);
  assert.ok(
    url.protocol === "https:" &&
      url.hostname === env.VAULT_HOST &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash,
  );
  assert.ok(url.pathname.endsWith("/" + stageKey + leaf));
  return url;
}
async function store(variable, leaf, data) {
  return fetch(vaultUrl(variable, leaf), {
    method: "PUT",
    body: data,
    redirect: "error",
    headers: { "if-none-match": "*" },
    signal: AbortSignal.timeout(20000),
  });
}
async function parent() {
  const leaf = stage === "faq-before" ? "title.case" : "approved.case";
  const response = await fetch(vaultUrl("CASE_INPUT_URL", leaf), {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  assert.ok(
    response.ok &&
      Number(response.headers.get("content-length")) > 0 &&
      Number(response.headers.get("content-length")) < 40 * 1024 * 1024,
  );
  const data = Buffer.from(await response.arrayBuffer());
  const record = openCase(data);
  if (stage === "faq-before") {
    assert.equal(record.stage, "title");
    assert.equal(record.result, "verified");
    assert.equal(record.sha, env.GITHUB_SHA);
    assert.equal(record.revision, digest(page("initial")));
    assert.equal(record.observed, title);
    assert.equal(record.objective, digest(titleObjective));
  } else {
    requireApproval(record);
    assert.equal(record.proposal.before.sha, env.GITHUB_SHA);
  }
  return {
    hash: digest(data),
    stage: record.stage,
    revision: record.revision ?? record.proposal.child,
  };
}
async function prepare() {
  assert.ok(live);
  if (localArtifact) {
    checkDevelopmentApproval();
    seal({ probe: true });
    if (hackathon && stage === "faq-after") {
      assert.match(env.BEFORE_RUN_ID ?? "", /^[1-9]\d*$/);
      const bytes = await readFile(join(env.RUNNER_TEMP, "before", "fieldnote.case"));
      const before = openCase(bytes);
      assert.equal(before.operation, "hack-faq-before");
      assert.equal(before.run, env.BEFORE_RUN_ID);
      assert.equal(before.result, "observed-defect");
      assert.equal(before.evidence?.failedStep, true);
      assert.equal(before.objective, digest(faqObjective));
      assert.equal(before.packHash, digest(Buffer.from(before.pack, "base64")));
      assert.notEqual(before.sha, env.GITHUB_SHA);
      assert.notEqual(before.revision, digest(page("initial")));
      await writeFile(work("parent"), JSON.stringify({ run: before.run, sha: before.sha, revision: before.revision, hash: digest(bytes) }), { flag: "wx" });
    }
    return;
  }
  assert.equal(env.APPROVED_RUN, env.GITHUB_RUN_NUMBER);
  assert.equal(env.APPROVED_SHA, env.GITHUB_SHA);
  assert.equal(env.APPROVED_STAGE, stage);
  assert.equal(env.ZERO_CHARGE, "confirmed");
  vaultUrl("CASE_OUTPUT_URL", stage + ".case");
  vaultUrl("ADMISSION_URL", stage + ".lock");
  seal({ probe: true });
  if (stage !== "title")
    await writeFile(work("parent"), JSON.stringify(await parent()), {
      flag: "wx",
    });
  const leaf = "probe-" + env.GITHUB_RUN_ID;
  assert.ok(
    (await store("VAULT_PROBE_URL", leaf, "fieldnote conditional write test"))
      .ok,
  );
  assert.equal(
    (await store("VAULT_PROBE_URL", leaf, "fieldnote conditional write test"))
      .status,
    412,
  );
  const unsigned = vaultUrl("VAULT_PROBE_URL", leaf);
  unsigned.search = "";
  const anonymous = await fetch(unsigned, {
    redirect: "error",
    signal: AbortSignal.timeout(6000),
  });
  await anonymous.body?.cancel();
  assert.ok([401, 403, 404].includes(anonymous.status), "Private vault accepted an anonymous read");
}
function checkDevelopmentApproval() {
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9]\d*$/);
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  assert.equal(env.APPROVED_DEV_RUN_ID, env.GITHUB_RUN_ID);
  assert.equal(env.APPROVED_SHA, env.GITHUB_SHA);
  assert.equal(env.APPROVED_STAGE, operation);
  if (hackathon) assert.equal(env.FIELDNOTE_NETWORK, "standard-runner-approved");
  assert.equal(env.ZERO_CHARGE, "confirmed");
}
async function admission() {
  const auth = JSON.parse(await readFile(work("identity"), "utf8"));
  assert.ok(
    auth.authenticated && Number.isFinite(auth.balance) && auth.balance > 0,
  );
  if (localArtifact) {
    checkDevelopmentApproval();
    await writeFile(join(env.RUNNER_TEMP, "fieldnote-title.admitted"), env.GITHUB_RUN_ID, {
      flag: "wx", mode: 0o600,
    });
    return;
  }
  const result = await store(
    "ADMISSION_URL",
    stage + ".lock",
    JSON.stringify({ stage, sha: env.GITHUB_SHA, run: env.GITHUB_RUN_ID }),
  );
  assert.ok(
    result.ok,
    "Admission exists or write failed. Inspect the original operation.",
  );
}

// The provider process runs as an unprivileged account inside the fixture namespace.
const cliEnv = () => ({
  HOME: env.HOME,
  PATH: env.PATH,
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  CI: "1",
  KANE_CLI_USER_AGENT: "fieldnote",
});
async function cli(...args) {
  try {
    const r = await execute(
      process.execPath,
      [
        "/opt/fieldnote/tools/node_modules/@testmuai/kane-cli/bin/kane-cli.cjs",
        ...args,
      ],
      {
        env: cliEnv(),
        cwd: env.HOME,
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { code: 0, stdout: r.stdout };
  } catch (e) {
    return {
      code: Number.isInteger(e.code) ? e.code : null,
      stdout: e.stdout || "",
    };
  }
}
async function identity() {
  const [user, accessKey] = JSON.parse(
    await readFile(join(env.CREDENTIALS_DIRECTORY, "login"), "utf8"),
  );
  const version = await cli("--version");
  assert.ok(version.code === 0 && /\b0\.10\.9\b/.test(version.stdout));
  assert.ok(user && accessKey);
  const login = await cli(
    "login",
    "--username",
    user,
    "--access-key",
    accessKey,
  );
  assert.equal(login.code, 0);
  const who = await cli("whoami");
  assert.ok(
    who.code === 0 &&
      who.stdout.includes(user) &&
      /\bbasic\b/i.test(who.stdout) &&
      /\bprod\b/i.test(who.stdout),
  );
  const balance = await cli("balance");
  const match = /^Available credits:\s*(\d+(?:\.\d+)?)\s*$/im.exec(
    stripVTControlCharacters(balance.stdout),
  );
  assert.ok(balance.code === 0 && match && Number.isFinite(Number(match[1])));
  process.stdout.write(
    JSON.stringify({ authenticated: true, balance: Number(match[1]) }),
  );
}
async function launch() {
  assert.ok(live);
  const served = await fetch("http://127.0.0.1:4318/", {
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  assert.ok(
    served.ok &&
      digest(await served.text()) ===
        digest(page(fixed ? "approved" : "initial")),
    "Fixture revision mismatch",
  );
  const r = await cli(
    "run",
    objective,
    "--agent",
    "--headless",
    "--cdp-endpoint",
    "http://127.0.0.1:4319",
    "--url",
    "http://127.0.0.1:4318/",
    "--max-steps",
    localArtifact && stage === "title" ? "3" : "5",
    "--timeout",
    localArtifact ? "90" : "150",
  );
  let malformed = false;
  const events = [];
  for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed = true;
    }
  }
  const starts = events.filter((v) => v?.type === "stream_start");
  const ends = events.filter((v) => v?.type === "run_end");
  const end = ends[0] || {};
  const steps = events.filter((v) => !v?.type && Number.isInteger(v?.step));
  const value =
    end.final_state?.[stage === "title" ? "observed_title" : "visible_answer"];
  const result = {
    code: r.code,
    consistent:
      !malformed &&
      starts.length === 1 &&
      starts[0].surface === "run" &&
      starts[0].cli_version === "0.10.9" &&
      ends.length === 1 &&
      end === events.at(-1) &&
      !events.some((v) => ["error", "warning", "ask_user"].includes(v?.type)),
    status: ["passed", "failed"].includes(end.status) ? end.status : "unknown",
    reason:
      end.reason_code == null
        ? null
        : /^[a-z_]+\.[a-z_]+$/.test(end.reason_code)
          ? end.reason_code
          : "unknown",
    resultCode:
      end.result_code == null
        ? null
        : /^\d{3}$/.test(String(end.result_code))
          ? String(end.result_code)
          : "unknown",
    confirmed: end.verdict?.confirmed === true,
    completedSteps: steps.filter((s) => s.status === "done").length,
    failedSteps: steps.filter((s) => s.status === "failed").length,
    observed: [title, answer, "missing"].includes(value) ? value : "unknown",
    credits:
      typeof (end.credits_consumed ?? end.credits) === "number"
        ? (end.credits_consumed ?? end.credits)
        : null,
  };
  const sessions = join(env.HOME, ".testmuai", "kaneai", "sessions");
  const packs = [];
  for (const d of await readdir(sessions, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!d.isDirectory() || d.name === "active") continue;
    const folder = join(sessions, d.name, "evidence");
    for (const f of await readdir(folder, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (f.isFile() && f.name.endsWith(".evidence"))
        packs.push(join(folder, f.name));
    }
  }
  if (packs.length === 1 && (await lstat(packs[0])).size <= 16 * 1024 * 1024) {
    result.pack = (await readFile(packs[0])).toString("base64");
    if (localArtifact) result.executionId = basename(packs[0], ".evidence");
  }
  if (localArtifact && !result.executionId && typeof end.execution_id === "string")
    result.executionId = end.execution_id;
  if (localArtifact && typeof end.execution_id === "string" && end.execution_id !== result.executionId)
    result.consistent = false;
  if (localArtifact) {
    // Keep only structured provider diagnostics. Free text can contain signed URLs.
    result.errors = events.filter((event) => event?.type === "error").slice(0, 8).map((event) => ({
      code: typeof event.code === "string" && /^[\w.-]{1,80}$/.test(event.code) ? event.code : null,
      resultCode: /^\d{3}$/.test(String(event.result_code)) ? String(event.result_code) : null,
      reason: typeof event.reason_code === "string" && /^[\w.]{1,80}$/.test(event.reason_code) ? event.reason_code : null,
    }));
  }
  const post = await cli("balance");
  const amount = /^Available credits:\s*(-?\d+(?:\.\d+)?)\s*$/im.exec(
    stripVTControlCharacters(post.stdout),
  );
  result.remainingBalance =
    post.code === 0 && amount ? Number(amount[1]) : null;
  process.stdout.write(JSON.stringify(result));
}
async function settle() {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(work("terminal"), "utf8"));
  } catch {
    /* Interrupted provider. */
  }
  const pack = Buffer.from(raw.pack || "", "base64");
  let evidence = null;
  if (pack.length) {
    await writeFile(work("original.pack"), pack, { flag: "wx", mode: 0o600 });
    try {
      evidence = JSON.parse(
        (await execute("python3", ["ci/pack.py", work("original.pack")]))
          .stdout,
      );
    } catch {
      /* Retain invalid encrypted pack. */
    }
  }
  const expected = stage === "title" ? title : answer;
  const accounted =
    typeof raw.credits === "number" &&
    Number.isFinite(raw.credits) &&
    raw.credits >= 0;
  const pass =
    raw.code === 0 &&
    raw.status === "passed" &&
    [null, "100"].includes(raw.resultCode) &&
    [null, "success.complete"].includes(raw.reason) &&
    raw.observed === expected &&
    raw.completedSteps > 0 &&
    !raw.failedSteps;
  const defect =
    raw.code === 1 &&
    raw.status === "failed" &&
    (["710", "720"].includes(raw.resultCode) ||
      (raw.resultCode === "740" && raw.confirmed)) &&
    (raw.reason === null || raw.reason?.startsWith("assertion_error.")) &&
    raw.observed === "missing" &&
    raw.failedSteps > 0 &&
    evidence?.failedStep;
  const result =
    evidence &&
    (!localArtifact || (typeof raw.executionId === "string" &&
      /^[\w-]{1,128}$/.test(raw.executionId) && evidence.runId === raw.executionId)) &&
    accounted &&
    raw.consistent &&
    (hackathon ? (pass || (stage.startsWith("faq-") && defect)) : (stage === "faq-before" ? defect : pass))
      ? defect
        ? "observed-defect"
        : "verified"
      : "inconclusive";
  const record = {
    ...raw,
    ...(hackathon ? { operation } : {}),
    pack: pack.toString("base64"),
    packHash: digest(pack),
    stage,
    expected,
    result,
    evidence,
    initialBalance: JSON.parse(await readFile(work("identity"), "utf8"))
      .balance,
    parent:
      stage === "title" || (hackathon && stage === "faq-before")
        ? null
        : JSON.parse(await readFile(work("parent"), "utf8")),
    revision: digest(page(fixed ? "approved" : "initial")),
    objective: digest(objective),
    sha: env.GITHUB_SHA,
    run: env.GITHUB_RUN_ID,
  };
  if (localArtifact) {
    checkDevelopmentApproval();
    assert.equal(await readFile(join(env.RUNNER_TEMP, "fieldnote-title.admitted"), "utf8"), env.GITHUB_RUN_ID);
    await writeFile(join(env.RUNNER_TEMP, hackathon ? "fieldnote.case" : "fieldnote-title.case"), seal(record), {
      mode: 0o600, flag: "wx",
    });
    console.log("Encrypted development case prepared. Outcome:", result);
    assert.notEqual(result, "inconclusive");
    if (hackathon && stage === "faq-after") assert.equal(result, "verified");
    return;
  }
  const response = await store(
    "CASE_OUTPUT_URL",
    stage + ".case",
    seal(record),
  );
  assert.ok(response.ok, "Private evidence delivery failed");
  console.log("Private record retained. Outcome:", result);
  assert.notEqual(result, "inconclusive");
}
try {
  const action = {
    prepare,
    admission,
    identity,
    launch,
    settle,
    account: async () => {
      if (!env.CASE_OUTPUT_URL) return;
      assert.equal(env.ZERO_CHARGE, "confirmed");
      const record = JSON.parse(await readFile(work("identity"), "utf8"));
      assert.ok(
        (
          await store(
            "CASE_OUTPUT_URL",
            "account.case",
            seal({ stage: "account", ...record }),
          )
        ).ok,
      );
    },
  }[command];
  assert.ok(action);
  await action();
} catch {
  console.error(
    "Fieldnote stopped during",
    command,
    ". Check the approved private case and account settings.",
  );
  process.exitCode = 1;
}
