/**
 * An in-process stand-in for the subset of the GitHub REST API that cla.ts
 * uses. Routes are asserted against the two repositories and the two tokens,
 * so a request made with the wrong credential fails the test rather than
 * silently succeeding.
 */

import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export const PR_REPO = "FraiseHQ/fraise";
export const SIG_REPO = "FraiseHQ/cla-signatures";
export const PR_TOKEN = "pr-token";
export const SIG_TOKEN = "sig-token";

export type Commit = { author: { login: string } | null };
export type Comment = { id: number; body: string };
export type Status = { state: string; context: string; description: string };

export type MockState = {
	signatures: unknown[];
	blobSha: string;
	/** null means the file does not exist, so the endpoint answers 404. */
	allowlist: { entries: { login: string; reason: string }[] } | null;
	comments: Comment[];
	statuses: Status[];
	commits: Commit[];
	storeWritable: boolean;
	/**
	 * Reproduces the real failure: GitHub's contents API is cached, so a read
	 * issued right after a successful write can still return the pre-write
	 * blob. When set, the next N reads serve the content as it was before the
	 * most recent write.
	 */
	staleReadsAfterWrite: number;
};

export type Mock = {
	url: string;
	state: MockState;
	close: () => Promise<void>;
};

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64");
}

async function readBody(
	request: IncomingMessage,
): Promise<Record<string, string>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

export async function startMock(
	overrides: Partial<MockState> = {},
): Promise<Mock> {
	const state: MockState = {
		signatures: [],
		blobSha: "blob1",
		allowlist: null,
		comments: [],
		statuses: [],
		commits: [{ author: { login: "octocat" } }],
		storeWritable: true,
		staleReadsAfterWrite: 0,
		...overrides,
	};

	// The snapshot a stale read serves, and how many stale reads are left.
	let staleSnapshot: unknown[] = [];
	let staleSnapshotSha = "";
	let staleReadsLeft = 0;

	const server: Server = createServer((request, response) => {
		void handle(request, response).catch(() =>
			send(response, 500, { message: "mock error" }),
		);
	});

	function send(response: ServerResponse, code: number, body: unknown): void {
		const payload = Buffer.from(JSON.stringify(body));
		response.writeHead(code, {
			"content-type": "application/json",
			"content-length": String(payload.length),
		});
		response.end(payload);
	}

	function token(request: IncomingMessage): string {
		return (request.headers.authorization ?? "").replace(/^Bearer /, "");
	}

	async function handle(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const path = new URL(request.url ?? "/", "http://mock").pathname;
		const method = request.method ?? "GET";

		// --- pull request repository, PR_TOKEN only ---
		if (method === "GET" && path === `/repos/${PR_REPO}/pulls/1`) {
			if (token(request) !== PR_TOKEN)
				return send(response, 401, { message: "wrong token" });
			return send(response, 200, { head: { sha: "deadbeef" } });
		}

		if (method === "GET" && path === `/repos/${PR_REPO}/pulls/1/commits`) {
			if (token(request) !== PR_TOKEN)
				return send(response, 401, { message: "wrong token" });
			return send(response, 200, state.commits);
		}

		if (method === "GET" && path === `/repos/${PR_REPO}/issues/1/comments`) {
			return send(response, 200, state.comments);
		}

		if (method === "POST" && path.startsWith(`/repos/${PR_REPO}/statuses/`)) {
			state.statuses.push((await readBody(request)) as unknown as Status);
			return send(response, 201, {});
		}

		if (method === "POST" && path === `/repos/${PR_REPO}/issues/1/comments`) {
			const body = await readBody(request);
			const comment = {
				id: state.comments.length + 1,
				body: String(body.body),
			};
			state.comments.push(comment);
			return send(response, 201, comment);
		}

		if (
			method === "PATCH" &&
			path.startsWith(`/repos/${PR_REPO}/issues/comments/`)
		) {
			const id = Number(path.split("/").pop());
			const body = await readBody(request);
			for (const comment of state.comments) {
				if (comment.id === id) comment.body = String(body.body);
			}
			return send(response, 200, {});
		}

		// --- signature repository, SIG_TOKEN only ---
		if (
			method === "GET" &&
			path === `/repos/${SIG_REPO}/contents/signatures.json`
		) {
			if (token(request) !== SIG_TOKEN) {
				return send(response, 403, {
					message: "store read must use SIG_TOKEN",
				});
			}
			// A cached response carries the pre-write body *and* the pre-write
			// sha, which is what makes the follow-up write conflict rather
			// than silently duplicating.
			let served = state.signatures;
			let servedSha = state.blobSha;
			if (staleReadsLeft > 0) {
				staleReadsLeft -= 1;
				served = staleSnapshot;
				servedSha = staleSnapshotSha;
			}
			return send(response, 200, {
				content: encode({ signatures: served }),
				sha: servedSha,
			});
		}

		if (
			method === "GET" &&
			path === `/repos/${SIG_REPO}/contents/allowlist.json`
		) {
			if (state.allowlist === null)
				return send(response, 404, { message: "Not Found" });
			return send(response, 200, {
				content: encode(state.allowlist),
				sha: "allowlist-sha",
			});
		}

		if (
			method === "PUT" &&
			path === `/repos/${SIG_REPO}/contents/signatures.json`
		) {
			if (!state.storeWritable) {
				return send(response, 403, {
					message: "Resource not accessible by integration",
				});
			}
			if (token(request) !== SIG_TOKEN) {
				return send(response, 403, {
					message: "store write must use SIG_TOKEN",
				});
			}

			const body = await readBody(request);
			if (body.sha !== state.blobSha)
				return send(response, 409, { message: "stale blob sha" });

			const decoded = JSON.parse(
				Buffer.from(String(body.content), "base64").toString("utf8"),
			);
			staleSnapshot = state.signatures;
			staleSnapshotSha = state.blobSha;
			staleReadsLeft = state.staleReadsAfterWrite;
			state.signatures = (decoded as { signatures: unknown[] }).signatures;
			state.blobSha = `blob${Number(state.blobSha.slice(4)) + 1}`;
			return send(response, 200, { commit: { sha: "written" } });
		}

		return send(response, 404, { message: `no route for ${method} ${path}` });
	}

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}`,
		state,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}
