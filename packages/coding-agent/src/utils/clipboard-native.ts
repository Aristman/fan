import { createRequire } from "module";

export type ClipboardModule = {
	setText: (text: string) => Promise<void>;
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number>>;
};

const require = createRequire(import.meta.url);
let clipboard: ClipboardModule | null = null;

const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (!process.env.TERMUX_VERSION && hasDisplay) {
	try {
		clipboard = require("@mariozechner/clipboard") as ClipboardModule;
	} catch (e) {
		clipboard = null;
		if (process.env.FAN_DEBUG) {
			process.stderr.write(`[FAN_DEBUG] clipboard-native: require failed: ${e instanceof Error ? e.message : e}\n`);
		}
	}
}

export { clipboard };
