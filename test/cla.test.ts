import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { type Mock, PR_REPO, PR_TOKEN, SIG_REPO, SIG_TOKEN, startMock } from "./mock-github.ts";

const run = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cla.ts");

type Result = { code: number; output: string };

async function cla(mock: Mock, args: string[], env: Record<string, string> = {}): Promise<Result> {
	const options = {
		env: {
			...process.env,
			GITHUB_API_URL: mock.url,
			GITHUB_REPOSITORY: PR_REPO,
			GH_TOKEN: PR_TOKEN,
			SIG_REPO,
			SIG_TOKEN,
			SIG_BRANCH: "main",
			CLA_URL: "https://example.test/CLA.md",
			...env,
		},
	};

	try {
		const { stdout, stderr } = await run(
			process.execPath,
			["--no-warnings", script, ...args],
			options,
		);
		return { code: 0, output: stdout + stderr };
	} catch (error: unknown) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, output: (failure.stdout ?? "") + (failure.stderr ?? "") };
	}
}

test("blocks a pull request whose author has not signed", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"]);

	assert.equal(code, 1);
	assert.equal(mock.state.statuses.at(-1)?.state, "failure");
	assert.equal(mock.state.statuses.at(-1)?.context, "cla/signed");
	assert.match(output, /awaiting signature: octocat/);
	assert.equal(mock.state.comments.length, 1);
	assert.match(mock.state.comments[0]!.body, /<!-- cla-gate -->/);
});

test("a commit with no matching GitHub account is unsignable and blocks", async (t) => {
	const mock = await startMock({ commits: [{ author: null }] });
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"]);

	assert.equal(code, 1);
	assert.match(output, /\?unmatched-email/);
});

test("re-checking edits the existing comment instead of adding one", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	await cla(mock, ["check", "1"]);
	await cla(mock, ["check", "1"]);

	assert.equal(mock.state.comments.length, 1);
});

test("signing writes to the signature repository and records the origin", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	await cla(mock, ["sign", "1", "octocat", "583231"]);

	assert.equal(mock.state.signatures.length, 1);
	assert.deepEqual(Object.keys(mock.state.signatures[0] as object).sort(), [
		"date",
		"id",
		"login",
		"pr",
		"repo",
	]);
	assert.equal((mock.state.signatures[0] as { repo: string }).repo, PR_REPO);
});

test("signing is idempotent by account id, so a rename cannot duplicate", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	await cla(mock, ["sign", "1", "octocat", "583231"]);
	const { output } = await cla(mock, ["sign", "1", "octocat-renamed", "583231"]);

	assert.equal(mock.state.signatures.length, 1);
	assert.match(output, /already signed/);
});

test("passes once every author has signed", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	await cla(mock, ["sign", "1", "octocat", "583231"]);
	const { code } = await cla(mock, ["check", "1"]);

	assert.equal(code, 0);
	assert.equal(mock.state.statuses.at(-1)?.state, "success");
});

test("signature lookup is case insensitive", async (t) => {
	const mock = await startMock({ commits: [{ author: { login: "OctoCat" } }] });
	t.after(() => mock.close());

	await cla(mock, ["sign", "1", "octocat", "583231"]);

	assert.equal((await cla(mock, ["check", "1"])).code, 0);
});

test("bots are exempt by default, before any allowlist file exists", async (t) => {
	const mock = await startMock({ commits: [{ author: { login: "dependabot[bot]" } }] });
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"]);

	assert.equal(code, 0);
	assert.match(output, /allowlisted \(GitHub Apps/);
});

test("the stored allowlist exempts named logins and reports why", async (t) => {
	const mock = await startMock({
		commits: [{ author: { login: "ronsenbergvi" } }],
		allowlist: { entries: [{ login: "RonsenbergVI", reason: "project owner" }] },
	});
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"]);

	assert.equal(code, 0);
	assert.match(output, /allowlisted \(project owner\)/);
});

test("an allowlist entry does not exempt anyone else", async (t) => {
	const mock = await startMock({
		commits: [{ author: { login: "stranger" } }, { author: { login: "RonsenbergVI" } }],
		allowlist: { entries: [{ login: "RonsenbergVI", reason: "project owner" }] },
	});
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"]);

	assert.equal(code, 1);
	assert.match(output, /awaiting signature: stranger$/m);
});

test("the ALLOWLIST variable merges with the stored file", async (t) => {
	const mock = await startMock({
		commits: [{ author: { login: "stranger" } }],
		allowlist: { entries: [{ login: "RonsenbergVI", reason: "project owner" }] },
	});
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"], { ALLOWLIST: "stranger" });

	assert.equal(code, 0);
	assert.match(output, /ALLOWLIST environment variable/);
});

test("a denied cross-repository write explains the token, not the status code", async (t) => {
	const mock = await startMock({ storeWritable: false });
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["sign", "1", "newcomer", "999"]);

	assert.equal(code, 1);
	assert.match(output, /SIG_TOKEN needs contents:write/);
});

test("the allowlist subcommand prints the effective list", async (t) => {
	const mock = await startMock({
		allowlist: { entries: [{ login: "RonsenbergVI", reason: "project owner" }] },
	});
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["allowlist"], { ALLOWLIST: "extra-person" });

	assert.equal(code, 0);
	assert.match(output, /RonsenbergVI\tproject owner/);
	assert.match(output, /extra-person\tALLOWLIST environment variable/);
});

test("missing required configuration fails loudly", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"], { CLA_URL: "" });

	assert.equal(code, 1);
	assert.match(output, /CLA_URL is required/);
});

test("writes step outputs and can be told not to fail the job", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	const outputFile = join(tmpdir(), `cla-output-${process.pid}-${Date.now()}`);
	await writeFile(outputFile, "");

	const { code } = await cla(mock, ["check", "1"], {
		GITHUB_OUTPUT: outputFile,
		FAIL_ON_UNSIGNED: "false",
	});

	assert.equal(code, 0);
	const written = await readFile(outputFile, "utf8");
	assert.match(written, /^signed=false$/m);
	assert.match(written, /^missing=octocat$/m);
});
