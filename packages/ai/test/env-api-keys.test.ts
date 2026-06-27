/**
 * Tests for getEnvApiKey — environment variable resolution for LLM API keys.
 */

import { afterEach, describe, expect, test } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";

describe("getEnvApiKey", () => {
	// Track env vars we set so we can clean them up
	const setEnvVars: string[] = [];

	function setEnvVar(name: string, value: string | undefined): void {
		if (!setEnvVars.includes(name)) {
			setEnvVars.push(name);
		}
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}

	function withEnvVar(name: string, value: string, fn: () => void): void {
		const original = process.env[name];
		try {
			setEnvVar(name, value);
			fn();
		} finally {
			if (original === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = original;
			}
		}
	}

	afterEach(() => {
		for (const name of setEnvVars) {
			delete process.env[name];
		}
		setEnvVars.length = 0;
	});

	describe("envOverrides parameter (from models.json envVar field)", () => {
		test("getEnvApiKey with envOverrides returns the env var value", () => {
			withEnvVar("MY_CUSTOM_KEY", "secret", () => {
				const result = getEnvApiKey("custom", { custom: "MY_CUSTOM_KEY" });
				expect(result).toBe("secret");
			});
		});

		test("getEnvApiKey with envOverrides for unset env var returns undefined", () => {
			const result = getEnvApiKey("custom", { custom: "UNSET_VAR_THAT_DOES_NOT_EXIST_12345" });
			expect(result).toBeUndefined();
		});

		test("envOverrides is optional and missing key gracefully handles undefined", () => {
			const result = getEnvApiKey("nonexistent-provider");
			expect(result).toBeUndefined();
		});

		test("envOverrides with empty object works (no overrides)", () => {
			const result = getEnvApiKey("nonexistent-provider", {});
			expect(result).toBeUndefined();
		});

		test("envOverrides with empty string env var returns undefined (empty treated as unset)", () => {
			withEnvVar("EMPTY_VAR_KEY", "", () => {
				const result = getEnvApiKey("custom", { custom: "EMPTY_VAR_KEY" });
				// Empty string is treated as unset (falsy)
				expect(result).toBeUndefined();
			});
		});

		test("envOverrides override takes priority over no default mapping", () => {
			withEnvVar("MY_PROVIDER_API_KEY", "override-secret", () => {
				// 'custom-provider' is not in the default envMap
				const withoutOverride = getEnvApiKey("custom-provider");
				expect(withoutOverride).toBeUndefined();

				// With override pointing to a set env var
				const withOverride = getEnvApiKey("custom-provider", { "custom-provider": "MY_PROVIDER_API_KEY" });
				expect(withOverride).toBe("override-secret");
			});
		});

		test("multiple providers can have separate envOverrides", () => {
			withEnvVar("PROVIDER_A_KEY", "key-a", () => {
				withEnvVar("PROVIDER_B_KEY", "key-b", () => {
					const overrides = {
						"provider-a": "PROVIDER_A_KEY",
						"provider-b": "PROVIDER_B_KEY",
					};

					expect(getEnvApiKey("provider-a", overrides)).toBe("key-a");
					expect(getEnvApiKey("provider-b", overrides)).toBe("key-b");
				});
			});
		});
	});

	describe("known providers (default env map)", () => {
		test("getEnvApiKey for known provider returns env var value", () => {
			withEnvVar("OPENAI_API_KEY", "sk-openai-test", () => {
				const result = getEnvApiKey("openai");
				expect(result).toBe("sk-openai-test");
			});
		});

		test("getEnvApiKey for known provider with unset env var returns undefined", () => {
			// Ensure the env var is unset
			delete process.env.GEMINI_API_KEY;
			const result = getEnvApiKey("google");
			expect(result).toBeUndefined();
		});

		test("openai maps to OPENAI_API_KEY", () => {
			withEnvVar("OPENAI_API_KEY", "sk-test", () => {
				expect(getEnvApiKey("openai")).toBe("sk-test");
			});
		});

		test("anthropic maps to ANTHROPIC_OAUTH_TOKEN first, then ANTHROPIC_API_KEY", () => {
			withEnvVar("ANTHROPIC_OAUTH_TOKEN", "oauth-token", () => {
				withEnvVar("ANTHROPIC_API_KEY", "api-key", () => {
					// OAuth token takes precedence
					expect(getEnvApiKey("anthropic")).toBe("oauth-token");
				});
			});
		});

		test("anthropic falls back to ANTHROPIC_API_KEY", () => {
			withEnvVar("ANTHROPIC_API_KEY", "sk-ant-test", () => {
				delete process.env.ANTHROPIC_OAUTH_TOKEN;
				expect(getEnvApiKey("anthropic")).toBe("sk-ant-test");
			});
		});

		test("github-copilot checks COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN", () => {
			// Priority: COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN
			withEnvVar("COPILOT_GITHUB_TOKEN", "copilot-token", () => {
				withEnvVar("GH_TOKEN", "gh-token", () => {
					withEnvVar("GITHUB_TOKEN", "github-token", () => {
						expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
					});
				});
			});
		});

		test("github-copilot falls back to GH_TOKEN", () => {
			withEnvVar("GH_TOKEN", "gh-token", () => {
				delete process.env.COPILOT_GITHUB_TOKEN;
				expect(getEnvApiKey("github-copilot")).toBe("gh-token");
			});
		});

		test("deepseek maps to DEEPSEEK_API_KEY", () => {
			withEnvVar("DEEPSEEK_API_KEY", "ds-key", () => {
				expect(getEnvApiKey("deepseek")).toBe("ds-key");
			});
		});

		test("groq maps to GROQ_API_KEY", () => {
			withEnvVar("GROQ_API_KEY", "gsk-test", () => {
				expect(getEnvApiKey("groq")).toBe("gsk-test");
			});
		});

		test("unknown provider without envOverrides returns undefined", () => {
			const result = getEnvApiKey("totally-unknown-provider-12345");
			expect(result).toBeUndefined();
		});
	});
});
