#!/usr/bin/env node
process.title = "fan";
process.emitWarning = (() => {}) as typeof process.emitWarning;

await import("../cli.js");
