// Default RECURRING.md template for fan-mission init.
// Recurring tasks with per-item interval configuration.
// Format: - [ ] Task text (interval: 30m)
// Alternative: ## Task text (interval: 30m)
// Intervals: Ns (seconds), Nm (minutes), Nh (hours), Nd (days).
// Missing/invalid interval defaults to 5 minutes (300000ms).

export const RECURRING_MD = `# Recurring tasks

<!-- Format: - [ ] Task text (interval: 30m) -->
<!-- Alternative (also parsed): ## Task text (interval: 30m) -->
<!-- Example: - [ ] Describe the periodic task (interval: 30m) -->
<!-- Intervals: Ns (seconds), Nm (minutes), Nh (hours), Nd (days) -->
<!-- Default interval (if missing or invalid): 5m -->
`;
