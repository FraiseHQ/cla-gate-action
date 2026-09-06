#!/usr/bin/env node
/**
 * CLA gate.
 *
 *   cla.ts gate                             read the GitHub event, sign if it is a
 *                                           signing comment, then check
 *   cla.ts gate  <pr> [<login> <user-id>]   the same, driven by hand
 *   cla.ts sign  <pr> <login> <user-id>     record a signature only
 *   cla.ts check <pr>                       set the cla/signed status on the PR head
 *   cla.ts allowlist                        print the effective allowlist
 *
 * `gate` is what the action runs. It exists because sign-then-check as two
 * processes reads the signature store twice, and GitHub's contents API can
 * still serve the pre-write blob milliseconds after the write returns 200 —
 * so the check would report the signer as unsigned and fail a run whose
 * signature had in fact landed.
 *
 * Two repositories, two tokens:
 *
 *   - the pull request lives in GITHUB_REPOSITORY and is read/annotated with
 *     GH_TOKEN (the workflow's own GITHUB_TOKEN is enough);
 *   - signatures live at SIG_PATH on SIG_BRANCH of SIG_REPO and are written
 *     with SIG_TOKEN, which must be a credential with contents:write on that
 *     repository. GITHUB_TOKEN cannot write across repositories.
 *
 * No dependencies: run with Node >= 22.18 (type stripping, global fetch).
 */

import { appendFileSync, readFileSync } from "node:fs";

// --- configuration -----------------------------------------------------------

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

/** Treats an empty string as unset, which is how Actions passes an unset input. */
function optional(name: string): string | undefined {
	return process.env[name] || undefined;
}

const repo = required("GITHUB_REPOSITORY");
const token = required("GH_TOKEN");

const config = {
	apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
	claUrl: required("CLA_URL"),
	statusContext: process.env.STATUS_CONTEXT ?? "cla/signed",

	/** When false, an unsigned pull request still fails the status but not the job. */
	failOnUnsigned: (process.env.FAIL_ON_UNSIGNED ?? "true") !== "false",

	/** Extra allowlist entries, space separated. Merged with the stored file. */
	extraAllowlist: (process.env.ALLOWLIST ?? "").split(/\s+/).filter(Boolean),

	pr: { repo, token },

	store: {
		repo: optional("SIG_REPO") ?? repo,
		token: optional("SIG_TOKEN") ?? token,
		branch: process.env.SIG_BRANCH ?? "main",
		path: process.env.SIG_PATH ?? "signatures.json",
		allowlistPath: process.env.ALLOWLIST_PATH ?? "allowlist.json",
	},
};

/** The exact phrase a contributor posts to sign. Must match what the comment tells them. */
const MAGIC = process.env.MAGIC_PHRASE || "I have read the CLA Document and I hereby sign the CLA";
const MARKER = "<!-- cla-gate -->";
const UNMATCHED = "?unmatched-email";

// --- types -------------------------------------------------------------------

type Signature = {
	login: string;
	id: number;
	date: string;
	repo: string;
	pr: number;
};

type Store = {
	signatures: Signature[];
};

type StoreFile = {
	signatures: Signature[];
	blobSha: string;
};

type AllowlistEntry = {
	/** A login, or a glob such as `*[bot]`. GitHub reserves the [bot] suffix. */
	login: string;
	reason: string;
};

type Allowlist = {
	entries: AllowlistEntry[];
};

type Commit = { author: { login: string } | null };
type Comment = { id: number; body: string };
type PullRequest = { head: { sha: string } };
type ContentsResponse = { content: string; sha: string };

type StatusState = "success" | "failure";

type GateResult = {
	signed: boolean;
	missing: string[];
};

type Client = {
	request: <T>(path: string, init?: RequestInit) => Promise<T>;
	paginate: <T>(path: string) => Promise<T[]>;
};

// --- api client --------------------------------------------------------------

function createClient(token: string): Client {
	async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await fetch(`${config.apiUrl}${path}`, {
			...init,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"x-github-api-version": "2022-11-28",
				...(init.body ? { "content-type": "application/json" } : {}),
				...init.headers,
			},
		});

		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${detail}`);
		}

		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	async function paginate<T>(path: string): Promise<T[]> {
		const separator = path.includes("?") ? "&" : "?";
		const results: T[] = [];

		for (let page = 1; ; page++) {
			const batch = await request<T[]>(`${path}${separator}per_page=100&page=${page}`);
			results.push(...batch);
			if (batch.length < 100) return results;
		}
	}

	return { request, paginate };
}

const prApi = createClient(config.pr.token);
const storeApi = createClient(config.store.token);

// --- pull request ------------------------------------------------------------

function headSha(pr: number): Promise<string> {
	return prApi
		.request<PullRequest>(`/repos/${config.pr.repo}/pulls/${pr}`)
		.then((it) => it.head.sha);
}

/**
 * Commit authors on a pull request. A commit whose email maps to no GitHub
 * account has no login to check against, so it is reported as unsignable and
 * always blocks.
 */
async function pullRequestAuthors(pr: number): Promise<string[]> {
	const commits = await prApi.paginate<Commit>(`/repos/${config.pr.repo}/pulls/${pr}/commits`);
	const logins = commits.map((commit) => commit.author?.login ?? UNMATCHED);
	return [...new Set(logins)].sort();
}

function setStatus(sha: string, state: StatusState, description: string): Promise<void> {
	return prApi.request(`/repos/${config.pr.repo}/statuses/${sha}`, {
		method: "POST",
		body: JSON.stringify({
			state,
			context: config.statusContext,
			description,
			target_url: config.claUrl,
		}),
	});
}

/** One bot comment per pull request, edited in place rather than appended. */
async function upsertComment(pr: number, body: string): Promise<void> {
	const comments = await prApi.paginate<Comment>(`/repos/${config.pr.repo}/issues/${pr}/comments`);
	const existing = comments.find((comment) => comment.body.includes(MARKER));

	if (existing) {
		await prApi.request(`/repos/${config.pr.repo}/issues/comments/${existing.id}`, {
			method: "PATCH",
			body: JSON.stringify({ body }),
		});
		return;
	}

	await prApi.request(`/repos/${config.pr.repo}/issues/${pr}/comments`, {
		method: "POST",
		body: JSON.stringify({ body }),
	});
}

// --- signature store ---------------------------------------------------------

const storeContentsPath = `/repos/${config.store.repo}/contents/${config.store.path}`;

async function fetchStore(): Promise<StoreFile> {
	const file = await storeApi.request<ContentsResponse>(
		`${storeContentsPath}?ref=${config.store.branch}`,
	);

	const parsed = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) as Store;
	return { signatures: parsed.signatures, blobSha: file.sha };
}

async function saveStore(file: StoreFile, message: string): Promise<void> {
	const body: Store = { signatures: file.signatures };

	try {
		await storeApi.request(storeContentsPath, {
			method: "PUT",
			body: JSON.stringify({
				message,
				branch: config.store.branch,
				sha: file.blobSha,
				content: Buffer.from(`${JSON.stringify(body, null, 2)}\n`).toString("base64"),
			}),
		});
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("-> 403") || message.includes("-> 404")) {
			throw new Error(
				`cannot write ${config.store.repo}. SIG_TOKEN needs contents:write on that ` +
					`repository — the workflow's GITHUB_TOKEN cannot write across repositories.\n${message}`,
			);
		}
		throw error;
	}
}

const hasSignedLogin = (signatures: Signature[], login: string): boolean =>
	signatures.some((signature) => equalLogins(signature.login, login));

/** Logins are renameable and reusable; account ids are not. */
const hasSignedId = (signatures: Signature[], id: number): boolean =>
	signatures.some((signature) => signature.id === id);

// --- allowlist ---------------------------------------------------------------

const DEFAULT_ALLOWLIST: AllowlistEntry[] = [
	{ login: "*[bot]", reason: "GitHub Apps; the [bot] suffix is reserved" },
];

/** GitHub logins are case insensitive. */
const equalLogins = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Glob match supporting `*` only, case insensitive. */
function matchesLogin(pattern: string, login: string): boolean {
	if (!pattern.includes("*")) return equalLogins(pattern, login);

	const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${source}$`, "i").test(login);
}

/**
 * Permanently exempt logins, read from the signature repository so one file
 * covers every repository in the organisation. A missing file is not an error:
 * the built-in defaults apply until you create one.
 */
async function fetchAllowlist(): Promise<AllowlistEntry[]> {
	const extra: AllowlistEntry[] = config.extraAllowlist.map((login) => ({
		login,
		reason: "ALLOWLIST environment variable",
	}));

	let stored: AllowlistEntry[];
	try {
		const file = await storeApi.request<ContentsResponse>(
			`/repos/${config.store.repo}/contents/${config.store.allowlistPath}?ref=${config.store.branch}`,
		);
		const parsed = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) as Allowlist;
		stored = parsed.entries;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("-> 404")) throw error;
		stored = DEFAULT_ALLOWLIST;
	}

	return [...stored, ...extra];
}

const findAllowlistEntry = (
	allowlist: AllowlistEntry[],
	login: string,
): AllowlistEntry | undefined => allowlist.find((entry) => matchesLogin(entry.login, login));

// --- rendering ---------------------------------------------------------------

function pendingComment(missing: string[]): string {
	const who = missing.map((login) => `\`${login}\``).join(", ");

	return [
		MARKER,
		"Thanks for the contribution.",
		"",
		`Before this can be merged, the following need to sign the [CLA](${config.claUrl}): ${who}`,
		"",
		"To sign, post a comment on this pull request containing exactly:",
		"",
		"```",
		MAGIC,
		"```",
	].join("\n");
}

// --- action outputs ----------------------------------------------------------

/** Write a step output when running inside GitHub Actions; a no-op elsewhere. */
function writeOutput(name: string, value: string): void {
	const file = process.env.GITHUB_OUTPUT;
	if (!file) return;
	appendFileSync(file, `${name}=${value}\n`);
}

// --- commands ----------------------------------------------------------------

/**
 * Records a signature and returns the store as it now stands, so a caller in
 * the same process can check against it without re-reading. Re-reading is the
 * bug this return exists to avoid: the contents API is cached, and a read
 * issued immediately after a successful write can still return the old blob.
 */
const SIGN_ATTEMPTS = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A 409 means the blob moved under us: another signer, or a cached read. */
const isConflict = (error: unknown): boolean =>
	error instanceof Error && error.message.includes("-> 409");

async function sign(pr: number, login: string, id: number): Promise<Signature[]> {
	for (let attempt = 1; ; attempt++) {
		const file = await fetchStore();

		if (hasSignedId(file.signatures, id)) {
			console.log(`${login} has already signed`);
			return file.signatures;
		}

		file.signatures.push({
			login,
			id,
			date: new Date().toISOString(),
			repo: config.pr.repo,
			pr,
		});

		try {
			await saveStore(file, `cla: ${login} signed (${config.pr.repo}#${pr})`);
			console.log(`recorded signature for ${login} in ${config.store.repo}`);
			return file.signatures;
		} catch (error: unknown) {
			// The write is a compare-and-swap on the blob sha, so a conflict
			// means someone signed between our read and our write — or that
			// our read came from the contents cache and was already behind.
			// Either way the answer is the same: read again and redo it.
			if (!isConflict(error)) throw error;
			if (attempt >= SIGN_ATTEMPTS) {
				throw new Error(
					`could not record ${login}'s signature after ${SIGN_ATTEMPTS} attempts: ` +
						`${config.store.path} kept changing under us. Either several people are ` +
						`signing at once, or the contents API is serving a cached copy. ` +
						`Re-running the job is safe — signing is idempotent by account id.`,
				);
			}

			const backoff = 250 * 2 ** (attempt - 1);
			console.log(`store moved under us, retrying in ${backoff}ms (${attempt}/${SIGN_ATTEMPTS})`);
			await sleep(backoff);
		}
	}
}

/**
 * @param known signatures already in hand from a sign in this same process.
 *              Passing them skips the re-read that the contents API cache
 *              would otherwise make unreliable.
 */
async function check(pr: number, known?: Signature[]): Promise<GateResult> {
	const [sha, authors, signatures, allowlist] = await Promise.all([
		headSha(pr),
		pullRequestAuthors(pr),
		known ? Promise.resolve(known) : fetchStore().then((f) => f.signatures),
		fetchAllowlist(),
	]);

	const missing: string[] = [];

	for (const login of authors) {
		const exempt = findAllowlistEntry(allowlist, login);
		if (exempt) {
			console.log(`${login}: allowlisted (${exempt.reason})`);
			continue;
		}
		if (!hasSignedLogin(signatures, login)) missing.push(login);
	}

	if (missing.length === 0) {
		await setStatus(sha, "success", "All contributors have signed the CLA");
		console.log("all contributors have signed");
		return { signed: true, missing };
	}

	await setStatus(sha, "failure", `Awaiting CLA signature: ${missing.join(", ")}`);
	await upsertComment(pr, pendingComment(missing));
	console.error(`awaiting signature: ${missing.join(", ")}`);
	return { signed: false, missing };
}

// --- entrypoint --------------------------------------------------------------

async function printAllowlist(): Promise<void> {
	for (const entry of await fetchAllowlist()) {
		console.log(`${entry.login}\t${entry.reason}`);
	}
}

type EventContext = {
	pr: number;
	signer?: { login: string; id: number };
};

/**
 * Derives the pull request and, if this run was triggered by a signing
 * comment, the signer — by reading the event payload GitHub already wrote to
 * disk.
 *
 * Deliberately not passed in as workflow arguments. Interpolating
 * `${{ ... }}` into a shell command means a YAML expression that can break in
 * ways nothing catches until a contributor is waiting: a folded block turns a
 * multi-line expression into one containing literal newlines, and the job
 * silently does the wrong thing. Reading the event needs no interpolation at
 * all, so the `run:` line is a constant.
 *
 * It also means the magic phrase is matched here rather than in a workflow
 * `if:`, so the two cannot disagree about what counts as a signature.
 */
function contextFromEvent(): EventContext {
	const eventPath = required("GITHUB_EVENT_PATH");
	const eventName = required("GITHUB_EVENT_NAME");

	const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
		pull_request?: { number?: number };
		issue?: { number?: number; pull_request?: unknown };
		comment?: { body?: string; user?: { login?: string; id?: number } };
	};

	if (eventName === "issue_comment") {
		if (!event.issue?.pull_request) {
			throw new Error("issue_comment fired on an issue, not a pull request");
		}
		const pr = event.issue.number;
		if (pr === undefined) throw new Error("issue_comment event carries no issue number");

		const body = event.comment?.body ?? "";
		const login = event.comment?.user?.login;
		const id = event.comment?.user?.id;

		// Any other comment on the pull request is just a re-check.
		if (!body.includes(MAGIC) || login === undefined || id === undefined) {
			return { pr };
		}
		return { pr, signer: { login, id } };
	}

	const pr = event.pull_request?.number ?? event.issue?.number;
	if (pr === undefined) {
		throw new Error(`no pull request number in a ${eventName} event payload`);
	}
	return { pr };
}

/**
 * One run: record the signature if this was a signing comment, then check —
 * against the signatures we just wrote, not against a fresh read of them.
 */
async function gate(pr: number, signer?: { login: string; id: number }): Promise<GateResult> {
	const known = signer ? await sign(pr, signer.login, signer.id) : undefined;
	return check(pr, known);
}

function usage(): never {
	console.error(
		"usage: cla.ts {gate [<pr> [<login> <user-id>]] | sign <pr> <login> <user-id> | check <pr> | allowlist}",
	);
	process.exit(2);
}

async function main(argv: string[]): Promise<void> {
	const [command, ...args] = argv;

	switch (command) {
		case "gate": {
			const [pr, login, id] = args;
			if ((login && !id) || (!login && id)) usage();

			// No arguments: this is the action, and the event on disk is the
			// source of truth. Arguments: a human at a terminal.
			const ctx: EventContext = pr
				? {
						pr: Number(pr),
						signer: login && id ? { login, id: Number(id) } : undefined,
					}
				: contextFromEvent();

			const result = await gate(ctx.pr, ctx.signer);
			writeOutput("signed", String(result.signed));
			writeOutput("missing", result.missing.join(" "));

			if (!result.signed && config.failOnUnsigned) process.exitCode = 1;
			return;
		}
		case "sign": {
			const [pr, login, id] = args;
			if (!pr || !login || !id) usage();
			await sign(Number(pr), login, Number(id));
			return;
		}
		case "check": {
			const [pr] = args;
			if (!pr) usage();

			const result = await check(Number(pr));
			writeOutput("signed", String(result.signed));
			writeOutput("missing", result.missing.join(" "));

			if (!result.signed && config.failOnUnsigned) process.exitCode = 1;
			return;
		}
		case "allowlist":
			await printAllowlist();
			return;
		default:
			usage();
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
