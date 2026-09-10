import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const crawl4aiModuleUrl = new URL("../crawl4ai.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "CRAWL4AI_BASE_URL", "CRAWL4AI_API_TOKEN",
		"FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "GEMINI_API_KEY",
		"BRIGHTDATA_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "BRIGHTDATA_UNLOCKER_ZONE",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

const PUBLIC_LOOKUP = `async () => [{ address: "93.184.216.34", family: 4 }]`;

async function configHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-crawl4ai-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

test("Crawl4AI extraction posts a fit markdown request with a bearer token and titles from the first heading", async () => {
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({
				url: "https://example.com/article",
				filter: "fit",
				markdown: "# Example Domain\\nThis domain is for use in documentation examples.\\n",
				success: true,
			}), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const result = await extractWithCrawl4ai("https://example.com/article", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ captured, result }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com/", CRAWL4AI_API_TOKEN: "c4a-test-token" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.captured.url, "https://crawl.example.com/md");
	assert.equal(output.captured.headers.authorization, "Bearer c4a-test-token");
	assert.equal(output.captured.headers["content-type"], "application/json");
	assert.deepEqual(output.captured.body, { url: "https://example.com/article", f: "fit" });
	assert.deepEqual(output.result, {
		url: "https://example.com/article",
		title: "Example Domain",
		content: "# Example Domain\nThis domain is for use in documentation examples.",
		error: null,
	});
});

test("Crawl4AI extraction sends no Authorization header without a token and returns null for empty markdown", async () => {
	const child = runChild(`
		let headers = null;
		globalThis.fetch = async (_url, init) => {
			headers = Object.fromEntries(new Headers(init.headers));
			return new Response(JSON.stringify({ success: true, markdown: "  \\n" }), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const result = await extractWithCrawl4ai("https://example.com/empty", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ headers, result }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.headers.authorization, undefined);
	assert.equal(output.result, null);
});

test("Crawl4AI resolves the token from a config credential source", async () => {
	const home = await configHome({ crawl4aiBaseUrl: "https://crawl.example.com", crawl4aiApiToken: "$CRAWL4AI_TEST_TOKEN" });
	const child = runChild(`
		let authorization = null;
		globalThis.fetch = async (_url, init) => {
			authorization = Object.fromEntries(new Headers(init.headers)).authorization ?? null;
			return new Response(JSON.stringify({ success: true, markdown: "# Configured" }), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const result = await extractWithCrawl4ai("https://example.com/configured", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ authorization, result }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, CRAWL4AI_TEST_TOKEN: "from-env-source" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.authorization, "Bearer from-env-source");
	assert.equal(output.result.title, "Configured");
});

test("fetch_content falls back to configured Crawl4AI before hosted providers", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			return new Response(JSON.stringify({ success: true, markdown: "# Rendered\\nRendered body" }), { status: 200 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/client-rendered", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, result }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://example.com/client-rendered", "https://crawl.example.com/md"]);
	assert.deepEqual(output.result, { url: "https://example.com/client-rendered", title: "Rendered", content: "# Rendered\nRendered body", error: null });
});

test("fetch_content tries Firecrawl before Crawl4AI when both are configured", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			if (calls.length === 2) return new Response("gateway", { status: 502 });
			return new Response(JSON.stringify({ success: true, markdown: "# Second\\nSecond body" }), { status: 200 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/order", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, result }));
	`, { FIRECRAWL_BASE_URL: "https://firecrawl.example.com", CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://example.com/order",
		"https://firecrawl.example.com/v2/scrape",
		"https://crawl.example.com/md",
	]);
	assert.equal(output.result.content, "# Second\nSecond body");
});

test("Crawl4AI extraction errors remain visible in fetch_content guidance", async () => {
	const home = await configHome({ crawl4aiBaseUrl: "https://crawl.example.com" });
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			return new Response("gateway", { status: 502 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/client-rendered", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, error: result.error }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /Crawl4AI fallback failed: Crawl4AI md error 502/);
	assert.match(output.error, /Set crawl4aiBaseUrl in/);
});

test("Crawl4AI malformed and unsuccessful envelopes throw visible errors", async () => {
	const child = runChild(`
		const responses = [
			[],
			{ markdown: "# No success flag" },
			{ success: true },
			{ success: false, error: "browser crashed" },
			{ success: false, detail: "Authentication required" },
		];
		let index = 0;
		globalThis.fetch = async () => new Response(JSON.stringify(responses[index++]), { status: 200 });
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const errors = [];
		for (let i = 0; i < responses.length; i++) {
			try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
			catch (err) { errors.push(err.message); }
		}
		console.log(JSON.stringify({ errors }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()).errors, [
		"Crawl4AI md returned an unexpected response shape",
		"Crawl4AI md returned an unexpected response shape",
		"Crawl4AI md returned markdown in an unexpected shape",
		"Crawl4AI md unsuccessful: browser crashed",
		"Crawl4AI md unsuccessful: Authentication required",
	]);
});

test("Crawl4AI rejects private targets without invoking the configured instance", async () => {
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		const errors = [];
		for (const target of ["http://127.0.0.1:8080/admin", "http://localhost:8080/admin", "http://169.254.169.254/latest/meta-data"]) {
			try { await extractWithCrawl4ai(target); } catch (err) { errors.push(err.message); }
		}
		try { await extractWithCrawl4ai("https://internal.example.com/", undefined, { lookup: async () => [{ address: "10.0.0.5", family: 4 }] }); }
		catch (err) { errors.push(err.message); }
		console.log(JSON.stringify({ errors, fetchCalls }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.errors.length, 4);
	assert.equal(output.fetchCalls, 0);
});

test("Crawl4AI API base allows configured loopback without global SSRF allow ranges", async () => {
	for (const crawl4aiBaseUrl of ["http://localhost:11235", "http://127.0.0.1:11235"]) {
		const home = await configHome({ crawl4aiBaseUrl });
		const child = runChild(`
			let calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				return new Response(JSON.stringify({ success: true, markdown: "# Local\\nLocal body" }), { status: 200 });
			};
			const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
			const result = await extractWithCrawl4ai("https://example.com/local", undefined, { lookup: ${PUBLIC_LOOKUP} });
			console.log(JSON.stringify({ calls, result }));
		`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.deepEqual(output.calls, [`${crawl4aiBaseUrl}/md`]);
		assert.equal(output.result.content, "# Local\nLocal body");
	}
});

test("Crawl4AI validates configured base redirects and strips the token on public cross-origin redirects", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), auth: Object.fromEntries(new Headers(init.headers)).authorization ?? null });
			if (calls.length === 1) return new Response("", { status: 307, headers: { location: "https://other.example.com/md" } });
			return new Response(JSON.stringify({ success: true, markdown: "# Redirected" }), { status: 200 });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com", CRAWL4AI_API_TOKEN: "c4a-secret" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()).calls, [
		{ url: "https://crawl.example.com/md", auth: "Bearer c4a-secret" },
		{ url: "https://other.example.com/md", auth: null },
	]);
});

test("Crawl4AI blocks configured base redirects to private targets", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
		};
		const { extractWithCrawl4ai } = await import(${JSON.stringify(crawl4aiModuleUrl)});
		let redirectError = null;
		try { await extractWithCrawl4ai("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { redirectError = err.message; }
		console.log(JSON.stringify({ calls, redirectError }));
	`, { CRAWL4AI_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://crawl.example.com/md"]);
	assert.match(output.redirectError, /Blocked internal address/);
});
