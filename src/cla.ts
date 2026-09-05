#!/usr/bin/env node
/**
 * CLA gate.
 *
 *   cla.ts sign      <pr> <login> <user-id>   record a signature
 *   cla.ts check     <pr>                     set the cla/signed status on the PR head
 *   cla.ts allowlist                          print the effective allowlist
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

import { appendFileSync } from "node:fs";

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

const MAGIC = "I have read the CLA Document and I hereby sign the CLA";
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

async function sign(pr: number, login: string, id: number): Promise<void> {
	const file = await fetchStore();

	if (hasSignedId(file.signatures, id)) {
		console.log(`${login} has already signed`);
		return;
	}

	file.signatures.push({
		login,
		id,
		date: new Date().toISOString(),
		repo: config.pr.repo,
		pr,
	});

	await saveStore(file, `cla: ${login} signed (${config.pr.repo}#${pr})`);
	console.log(`recorded signature for ${login} in ${config.store.repo}`);
}

async function check(pr: number): Promise<GateResult> {
	const [sha, authors, file, allowlist] = await Promise.all([
		headSha(pr),
		pullRequestAuthors(pr),
		fetchStore(),
		fetchAllowlist(),
	]);

	const missing: string[] = [];

	for (const login of authors) {
		const exempt = findAllowlistEntry(allowlist, login);
		if (exempt) {
			console.log(`${login}: allowlisted (${exempt.reason})`);
			continue;
		}
		if (!hasSignedLogin(file.signatures, login)) missing.push(login);
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

function usage(): never {
	console.error("usage: cla.ts {sign <pr> <login> <user-id> | check <pr> | allowlist}");
	process.exit(2);
}

async function main(argv: string[]): Promise<void> {
	const [command, ...args] = argv;

	switch (command) {
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
