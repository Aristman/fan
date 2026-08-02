import type { Finding, SessionScore } from "./types.js";

/**
 * Calculate overall session score based on findings.
 * Start at 100, deduct per severity level. Floor at 0.
 */
export function calculateScore(findings: Finding[], truncated: boolean): SessionScore {
	let score = 100;
	const metrics: Record<string, number | string> = {};

	// Severity penalties
	const penalties: Record<string, number> = {
		high: 15,
		medium: 7,
		low: 2,
	};

	// Count by severity
	const counts = { high: 0, medium: 0, low: 0 };

	for (const finding of findings) {
		counts[finding.severity]++;
		score -= penalties[finding.severity] || 0;
	}

	score = Math.max(0, score);

	// Extract key metrics — FIX MINOR 7: use structured metrics field, regex as fallback
	for (const finding of findings) {
		if (finding.detectorId === "D3") {
			// Prefer structured metrics
			if (finding.metrics?.durationMin !== undefined) {
				metrics["durationMin"] = finding.metrics.durationMin;
			} else {
				// Regex fallback
				const match = finding.evidence.excerpt.match(/Session total:\s*([\d.]+)\s*min/);
				if (match) metrics["durationMin"] = parseFloat(match[1]);
			}
		}
		if (finding.detectorId === "D9") {
			// Prefer structured metrics
			if (finding.metrics?.totalTokens !== undefined) {
				metrics["totalTokens"] = finding.metrics.totalTokens;
			} else {
				const tokenMatch = finding.evidence.excerpt.match(/Total tokens:\s*([\d,]+)/);
				if (tokenMatch) metrics["totalTokens"] = parseInt(tokenMatch[1].replace(/,/g, ""));
			}
			if (finding.metrics?.totalCost !== undefined) {
				metrics["totalCost"] = finding.metrics.totalCost;
			} else {
				const costMatch = finding.evidence.excerpt.match(/Total cost:\s*\$([\d.]+)/);
				if (costMatch) metrics["totalCost"] = parseFloat(costMatch[1]);
			}
			if (finding.metrics?.cacheRead !== undefined) {
				metrics["cacheRead"] = finding.metrics.cacheRead;
			}
			if (finding.metrics?.cacheWrite !== undefined) {
				metrics["cacheWrite"] = finding.metrics.cacheWrite;
			}
			if (finding.metrics?.tokenSource !== undefined) {
				metrics["tokenSource"] = finding.metrics.tokenSource === 1 ? "sqlite" : "jsonl";
			}
		}
	}

	metrics["findingsHigh"] = counts.high;
	metrics["findingsMedium"] = counts.medium;
	metrics["findingsLow"] = counts.low;
	metrics["findingsTotal"] = counts.high + counts.medium + counts.low;

	if (truncated) {
		metrics["truncated"] = "yes";
	}

	return {
		total: score,
		findings,
		metrics,
		truncated,
	};
}
