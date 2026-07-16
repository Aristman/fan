import type { ExtensionAPI } from "@seaagents/fan-coding-agent";

export default function widgetPlacementExtension(fan: ExtensionAPI) {
	fan.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
