import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { activityMonitor } from "./activity.ts";
import { redactCredential, resolveCredential } from "./credential-source.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { loadSsrfConfig, validateRemoteUrl, type Lookup } from "./ssrf-protection.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();
const EXTRACT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MARKDOWN_FILTER = "fit";

export interface Crawl4aiSsrfOptions {
	allowRanges: string[];
	trustEnvProxy: boolean;
}

export interface Crawl4aiExtractOptions extends Pick<ExtractOptions, "timeoutMs" | "lookup"> {
	ssrf?: Crawl4aiSsrfOptions;
}

interface Crawl4aiConfig {
	crawl4aiBaseUrl?: unknown;
	crawl4aiApiToken?: unknown;
}

let cachedConfig: Crawl4aiConfig | null = null;

function loadConfig(): Crawl4aiConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	cachedConfig = parsed as Crawl4aiConfig;
	return cachedConfig;
}

export function clearCrawl4aiConfigCache(): void {
	cachedConfig = null;
}

function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Crawl4AI base URL in ${CONFIG_PATH}: expected an HTTP or HTTPS URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Invalid Crawl4AI base URL in ${CONFIG_PATH}: expected an HTTP or HTTPS URL`);
	}
	if (parsed.username || parsed.password) {
		throw new Error(`Invalid Crawl4AI base URL in ${CONFIG_PATH}: URL credentials are not allowed`);
	}
	parsed.pathname = parsed.pathname.replace(/\/+$/, "");
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "");
}

function getBaseUrl(): string | null {
	return normalizeBaseUrl(process.env.CRAWL4AI_BASE_URL) ?? normalizeBaseUrl(loadConfig().crawl4aiBaseUrl);
}

function requireBaseUrl(): string {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"Crawl4AI base URL not configured. Either:\n" +
			`  1. Set crawl4aiBaseUrl in ${CONFIG_PATH}\n` +
			"  2. Set CRAWL4AI_BASE_URL environment variable",
		);
	}
	return baseUrl;
}

async function getApiToken(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Crawl4AI",
		configuredValue: loadConfig().crawl4aiApiToken,
		environmentValue: process.env.CRAWL4AI_API_TOKEN,
		signal,
	});
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function ssrfOptions(options?: Crawl4aiExtractOptions): { lookup?: Lookup; allowRanges: string[]; trustEnvProxy: boolean } {
	const config = loadSsrfConfig();
	return {
		allowRanges: options?.ssrf?.allowRanges ?? config.allowRanges,
		trustEnvProxy: options?.ssrf?.trustEnvProxy ?? config.trustEnvProxy,
		...(options?.lookup ? { lookup: options.lookup } : {}),
	};
}

function isLoopbackApiUrl(url: URL): boolean {
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (hostname === "localhost" || hostname === "::1") return true;
	if (net.isIP(hostname) !== 4) return false;
	return hostname.split(".")[0] === "127";
}

function withoutSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
	const next = { ...headers };
	delete next.Authorization;
	delete next.authorization;
	delete next.Cookie;
	delete next.cookie;
	return next;
}

async function fetchCrawl4aiApi(
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
	options: Crawl4aiExtractOptions | undefined,
): Promise<Response> {
	const apiSsrf = { ...ssrfOptions(options), allowLoopback: isLoopbackApiUrl(new URL(url)) };
	let current = await validateRemoteUrl(url, apiSsrf);
	let headers = init.headers;
	for (let redirects = 0; redirects <= DEFAULT_MAX_REDIRECTS; redirects++) {
		const response = await fetch(current, { ...init, headers, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === DEFAULT_MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${current.toString()}`);

		const next = await validateRemoteUrl(new URL(location, current), apiSsrf);
		if (next.origin !== current.origin) headers = withoutSensitiveHeaders(headers);
		current = next;
	}
	throw new Error(`Too many redirects fetching ${current.toString()}`);
}

function firstHeadingTitle(markdown: string): string {
	for (const line of markdown.split("\n")) {
		const match = /^#\s+(.+?)\s*$/.exec(line.trim());
		if (match) return match[1];
	}
	return "";
}

export function isCrawl4aiAvailable(): boolean {
	return getBaseUrl() !== null;
}

export async function extractWithCrawl4ai(
	url: string,
	signal?: AbortSignal,
	options?: Crawl4aiExtractOptions,
): Promise<ExtractedContent | null> {
	const baseUrl = requireBaseUrl();
	await validateRemoteUrl(url, ssrfOptions(options));
	const token = await getApiToken(signal);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const requestUrl = `${baseUrl}/md`;
	const activityId = activityMonitor.logStart({ type: "fetch", url: requestUrl });
	try {
		const response = await fetchCrawl4aiApi(requestUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({ url, f: MARKDOWN_FILTER }),
			signal: requestSignal(options?.timeoutMs ?? EXTRACT_TIMEOUT_MS, signal),
		}, options);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Crawl4AI md error ${response.status}: ${redactCredential(text.slice(0, 300), token)}`);
		}
		let data: unknown;
		try {
			data = await response.json();
		} catch (err) {
			throw new Error(`Crawl4AI md returned invalid JSON: ${errorMessage(err)}`);
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			throw new Error("Crawl4AI md returned an unexpected response shape");
		}
		const envelope = data as Record<string, unknown>;
		if (envelope.success === false) {
			const detail = typeof envelope.error === "string" ? envelope.error : typeof envelope.detail === "string" ? envelope.detail : "";
			throw new Error(`Crawl4AI md unsuccessful: ${redactCredential(detail.trim() || "unknown error", token)}`);
		}
		if (envelope.success !== true) {
			throw new Error("Crawl4AI md returned an unexpected response shape");
		}
		if (typeof envelope.markdown !== "string") {
			throw new Error("Crawl4AI md returned markdown in an unexpected shape");
		}
		activityMonitor.logComplete(activityId, response.status);
		const content = envelope.markdown.trim();
		if (!content) return null;
		return { url, title: firstHeadingTitle(content), content, error: null };
	} catch (err) {
		if (isAbortError(err)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, errorMessage(err));
		throw err;
	}
}
