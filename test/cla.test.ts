import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
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
		const failure = error as {
			code?: number;
			stdout?: string;
			stderr?: string;
		};
		return {
			code: failure.code ?? 1,
			output: (failure.stdout ?? "") + (failure.stderr ?? ""),
		};
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
	assert.match(mock.state.comments[0]?.body ?? "", /<!-- cla-gate -->/);
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
	const mock = await startMock({
		commits: [{ author: { login: "dependabot[bot]" } }],
	});
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"]);

	assert.equal(code, 0);
	assert.match(output, /allowlisted \(GitHub Apps/);
});

test("the stored allowlist exempts named logins and reports why", async (t) => {
	const mock = await startMock({
		commits: [{ author: { login: "ronsenbergvi" } }],
		allowlist: {
			entries: [{ login: "RonsenbergVI", reason: "project owner" }],
		},
	});
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"]);

	assert.equal(code, 0);
	assert.match(output, /allowlisted \(project owner\)/);
});

test("an allowlist entry does not exempt anyone else", async (t) => {
	const mock = await startMock({
		commits: [{ author: { login: "stranger" } }, { author: { login: "RonsenbergVI" } }],
		allowlist: {
			entries: [{ login: "RonsenbergVI", reason: "project owner" }],
		},
	});
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"]);

	assert.equal(code, 1);
	assert.match(output, /awaiting signature: stranger$/m);
});

test("the ALLOWLIST variable merges with the stored file", async (t) => {
	const mock = await startMock({
		commits: [{ author: { login: "stranger" } }],
		allowlist: {
			entries: [{ login: "RonsenbergVI", reason: "project owner" }],
		},
	});
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["check", "1"], {
		ALLOWLIST: "stranger",
	});

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
		allowlist: {
			entries: [{ login: "RonsenbergVI", reason: "project owner" }],
		},
	});
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["allowlist"], {
		ALLOWLIST: "extra-person",
	});

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

// --- the sign-then-check race -----------------------------------------------
//
// Reported in production: a contributor posted the signing phrase, the
// signature landed in the store, and the same run failed anyway — because the
// check re-read the store and GitHub's contents cache still served the blob
// from before the write.

test("gate passes when the store read after signing is stale", async (t) => {
	const mock = await startMock({ staleReadsAfterWrite: 5 });
	t.after(() => mock.close());

	const { code, output } = await cla(mock, ["gate", "1", "octocat", "583231"]);

	assert.equal(code, 0, `gate failed on a stale read:\n${output}`);
	assert.equal(mock.state.statuses.at(-1)?.state, "success");
	assert.equal(mock.state.signatures.length, 1);
});

test("separate sign and check still race, which is why the action runs gate", async (t) => {
	const mock = await startMock({ staleReadsAfterWrite: 5 });
	t.after(() => mock.close());

	await cla(mock, ["sign", "1", "octocat", "583231"]);
	const { code } = await cla(mock, ["check", "1"]);

	// Documents the behaviour rather than endorsing it: the signature is in
	// the store, and a second process reading through the cache cannot see it.
	assert.equal(code, 1);
	assert.equal(mock.state.signatures.length, 1);
});

test("gate without a signer is a plain check", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	const first = await cla(mock, ["gate", "1"]);
	assert.equal(first.code, 1);

	await cla(mock, ["sign", "1", "octocat", "583231"]);

	const second = await cla(mock, ["gate", "1"]);
	assert.equal(second.code, 0);
});

test("a signer who comments twice is not recorded twice", async (t) => {
	// Two stale reads: the write conflicts, the retry re-reads past the cache.
	const mock = await startMock({ staleReadsAfterWrite: 2 });
	t.after(() => mock.close());

	await cla(mock, ["gate", "1", "octocat", "583231"]);
	const { code, output } = await cla(mock, ["gate", "1", "octocat", "583231"]);

	assert.equal(code, 0, output);
	assert.match(output, /already signed/);
	assert.equal(mock.state.signatures.length, 1);
});

test("a conflicting write is retried rather than duplicating a signature", async (t) => {
	const mock = await startMock({ staleReadsAfterWrite: 1 });
	t.after(() => mock.close());

	await cla(mock, ["gate", "1", "alice", "1"]);
	const { code, output } = await cla(mock, ["gate", "1", "bob", "2"]);

	assert.equal(code, 1, output); // alice is still unsigned on this PR's commits
	assert.match(output, /retrying/);
	assert.equal(mock.state.signatures.length, 2);
});

test("sustained staleness fails with an explanation, never a duplicate", async (t) => {
	const mock = await startMock({ staleReadsAfterWrite: 99 });
	t.after(() => mock.close());

	await cla(mock, ["gate", "1", "octocat", "583231"]);
	const { code, output } = await cla(mock, ["gate", "1", "someone-else", "999"]);

	assert.equal(code, 1);
	assert.match(output, /could not record someone-else's signature after 4 attempts/);
	assert.match(output, /Re-running the job is safe/);
	assert.equal(mock.state.signatures.length, 1);
});

// --- the path the action actually takes -------------------------------------
//
// The action runs `cla.ts gate` with no arguments and no interpolation: the
// pull request and the signer come from the event payload GitHub wrote to
// disk. These drive that path with real payload shapes.

async function withEvent(
	t: { after: (fn: () => unknown) => void },
	name: string,
	payload: unknown,
): Promise<Record<string, string>> {
	const file = join(
		tmpdir(),
		`cla-event-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
	);
	await writeFile(file, JSON.stringify(payload));
	t.after(() => rm(file, { force: true }));
	return { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: file };
}

const prEvent = { pull_request: { number: 1 } };

const commentEvent = (body: string, login = "octocat", id = 583231) => ({
	issue: {
		number: 1,
		pull_request: { url: "https://api.github.com/…/pulls/1" },
	},
	comment: { body, user: { login, id } },
});

test("action path: pull_request_target checks and does not sign", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	const env = await withEvent(t, "pull_request_target", prEvent);
	const { code, output } = await cla(mock, ["gate"], env);

	assert.equal(code, 1, output);
	assert.equal(mock.state.statuses.at(-1)?.state, "failure");
	assert.equal(mock.state.signatures.length, 0);
});

test("action path: the signing comment signs and passes in one run", async (t) => {
	const mock = await startMock({ staleReadsAfterWrite: 5 });
	t.after(() => mock.close());

	const env = await withEvent(
		t,
		"issue_comment",
		commentEvent("I have read the CLA Document and I hereby sign the CLA"),
	);
	const { code, output } = await cla(mock, ["gate"], env);

	assert.equal(code, 0, output);
	assert.equal(mock.state.statuses.at(-1)?.state, "success");
	assert.equal(mock.state.signatures.length, 1);
	assert.equal((mock.state.signatures[0] as { login: string }).login, "octocat");
});

test("action path: the phrase inside a longer comment still signs", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	const env = await withEvent(
		t,
		"issue_comment",
		commentEvent(
			"Sure, happy to.\n\nI have read the CLA Document and I hereby sign the CLA\n\nThanks!",
		),
	);

	assert.equal((await cla(mock, ["gate"], env)).code, 0);
	assert.equal(mock.state.signatures.length, 1);
});

test("action path: an unrelated comment re-checks without signing", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	const env = await withEvent(t, "issue_comment", commentEvent("any updates on this?"));
	const { code } = await cla(mock, ["gate"], env);

	assert.equal(code, 1);
	assert.equal(mock.state.signatures.length, 0);
	assert.equal(mock.state.statuses.at(-1)?.state, "failure");
});

test("action path: a custom magic phrase is honoured", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	const env = await withEvent(t, "issue_comment", commentEvent("I agree to the CLA."));
	const { code } = await cla(mock, ["gate"], {
		...env,
		MAGIC_PHRASE: "I agree to the CLA.",
	});

	assert.equal(code, 0);
	assert.equal(mock.state.signatures.length, 1);
});

test("action path: a comment on a plain issue fails with a clear message", async (t) => {
	const mock = await startMock();
	t.after(() => mock.close());

	const env = await withEvent(t, "issue_comment", {
		issue: { number: 7 },
		comment: { body: "hello", user: { login: "octocat", id: 1 } },
	});
	const { code, output } = await cla(mock, ["gate"], env);

	assert.equal(code, 1);
	assert.match(output, /issue_comment fired on an issue, not a pull request/);
});
