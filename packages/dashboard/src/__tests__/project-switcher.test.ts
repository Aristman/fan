// Tests for <fan-project-switcher> (F-2.6)
import type { ProjectSummary } from "@fan/api-gateway/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../components/project-switcher.js";
import type { FanProjectSwitcher } from "../components/project-switcher.js";

const PROJECTS: ProjectSummary[] = [
	{ path: "/a", name: "Alpha", type: "unknown", sessionCount: 2, available: true },
	{ path: "/b", name: "Beta", type: "unknown", sessionCount: 5, available: true },
];

function createEl(): FanProjectSwitcher {
	const el = document.createElement("fan-project-switcher") as FanProjectSwitcher;
	document.body.appendChild(el);
	return el;
}

async function openDropdown(el: FanProjectSwitcher): Promise<void> {
	el.querySelector<HTMLButtonElement>(".switcher-trigger")!.click();
	await el.updateComplete;
}

describe("fan-project-switcher", () => {
	let el: FanProjectSwitcher;

	beforeEach(() => {
		el = createEl();
	});

	afterEach(() => {
		el.remove();
	});

	// TC-F-2.6-1: dropdown renders all projects; current is highlighted
	it("renders 2 projects in the dropdown with Alpha active", async () => {
		el.projects = PROJECTS;
		el.currentProject = "/a";
		await el.updateComplete;
		await openDropdown(el);

		const items = el.querySelectorAll<HTMLButtonElement>(".project-item");
		expect(items.length).toBe(2);
		expect(items[0].textContent).toContain("Alpha");
		expect(items[1].textContent).toContain("Beta");
		expect(items[0].classList.contains("active")).toBe(true);
		expect(items[1].classList.contains("active")).toBe(false);
	});

	// TC-F-2.6-2: clicking Beta fires project-select with { path: '/b' }
	it("emits project-select with { path: '/b' } when Beta is clicked", async () => {
		el.projects = PROJECTS;
		el.currentProject = "/a";
		await el.updateComplete;
		await openDropdown(el);

		const events: CustomEvent[] = [];
		el.addEventListener("project-select", (e) => events.push(e as CustomEvent));

		const items = el.querySelectorAll<HTMLButtonElement>(".project-item");
		items[1].click();

		expect(events.length).toBe(1);
		expect(events[0].detail).toEqual({ path: "/b" });
		expect(events[0].bubbles).toBe(true);
		expect(events[0].composed).toBe(true);
	});

	// Dropdown closes after selection
	it("closes the dropdown after selecting a project", async () => {
		el.projects = PROJECTS;
		el.currentProject = null;
		await el.updateComplete;
		await openDropdown(el);

		el.querySelectorAll<HTMLButtonElement>(".project-item")[0].click();
		await el.updateComplete;

		expect(el.querySelector(".fan-dropdown-panel")).toBeNull();
	});

	// Filter narrows the list
	it("filters projects by name", async () => {
		el.projects = PROJECTS;
		el.currentProject = null;
		await el.updateComplete;
		await openDropdown(el);

		const input = el.querySelector<HTMLInputElement>(".filter-input")!;
		input.value = "alph";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;

		const items = el.querySelectorAll<HTMLButtonElement>(".project-item");
		expect(items.length).toBe(1);
		expect(items[0].textContent).toContain("Alpha");
	});

	// F-3.8: "+" button emits project-create (the app shell opens the
	// create-project dialog) and closes the dropdown
	it("emits project-create when '+' is clicked and closes the dropdown (F-3.8)", async () => {
		el.projects = PROJECTS;
		await el.updateComplete;
		await openDropdown(el);

		const events: CustomEvent[] = [];
		el.addEventListener("project-create", (e) => events.push(e as CustomEvent));

		el.querySelector<HTMLButtonElement>(".add-project-btn")!.click();
		await el.updateComplete;

		expect(events.length).toBe(1);
		expect(events[0].bubbles).toBe(true);
		expect(events[0].composed).toBe(true);

		// Dropdown closes after requesting creation
		expect(el.querySelector(".fan-dropdown-panel")).toBeNull();
	});

	// sessionCount indicator is visible next to the project name
	it("shows the sessionCount badge next to each project", async () => {
		el.projects = PROJECTS;
		el.currentProject = "/b";
		await el.updateComplete;
		await openDropdown(el);

		const badges = el.querySelectorAll<HTMLSpanElement>(".project-item .session-count");
		expect(badges.length).toBe(2);
		expect(badges[0].textContent?.trim()).toBe("2");
		expect(badges[1].textContent?.trim()).toBe("5");
	});

	// Empty project list renders an empty state (no crash)
	it("renders an empty state when there are no projects", async () => {
		el.projects = [];
		await el.updateComplete;
		await openDropdown(el);

		expect(el.querySelectorAll(".project-item").length).toBe(0);
		expect(el.textContent).toContain("No projects yet");
	});

	// F-2.13: unavailable project shows a "Not found on disk" indicator
	it("shows a not-found indicator for a project missing on disk (F-2.13)", async () => {
		el.projects = [
			...PROJECTS,
			{
				path: "/gone",
				name: "Gone",
				type: "unknown",
				sessionCount: 1,
				available: false,
				error: "PROJECT_NOT_FOUND",
			},
		];
		await el.updateComplete;
		await openDropdown(el);

		const items = el.querySelectorAll(".project-item");
		expect(items.length).toBe(3);
		const gone = items[2];
		expect(gone.querySelector(".not-found-label")).not.toBeNull();
		expect(gone.textContent).toContain("Not found on disk");
		// Available projects have no indicator
		expect(items[0].querySelector(".not-found-label")).toBeNull();
	});

	// F-2.13: remove button emits project-remove and does NOT select the project
	it("emits project-remove (not project-select) from the remove button of an unavailable project", async () => {
		el.projects = [
			{
				path: "/gone",
				name: "Gone",
				type: "unknown",
				sessionCount: 0,
				available: false,
				error: "PROJECT_NOT_FOUND",
			},
		];
		await el.updateComplete;
		await openDropdown(el);

		const removeEvents: CustomEvent[] = [];
		const selectEvents: CustomEvent[] = [];
		el.addEventListener("project-remove", (e) => removeEvents.push(e as CustomEvent));
		el.addEventListener("project-select", (e) => selectEvents.push(e as CustomEvent));

		const btn = el.querySelector<HTMLButtonElement>(".project-remove-btn");
		expect(btn).not.toBeNull();
		btn!.click();

		expect(removeEvents.length).toBe(1);
		expect(removeEvents[0].detail).toEqual({ path: "/gone" });
		expect(removeEvents[0].bubbles).toBe(true);
		expect(removeEvents[0].composed).toBe(true);
		// Click must not bubble into a project selection
		expect(selectEvents.length).toBe(0);
	});

	// F-2.13: available projects have no remove button
	it("does not render a remove button for available projects", async () => {
		el.projects = PROJECTS;
		await el.updateComplete;
		await openDropdown(el);

		expect(el.querySelector(".project-remove-btn")).toBeNull();
	});
});

describe("fan-project-switcher workspace type icons (F-3.7)", () => {
	let el: FanProjectSwitcher;

	beforeEach(() => {
		el = createEl();
	});

	afterEach(() => {
		el.remove();
	});

	// TC-F-3.7-1: research project renders the research icon with class type-research
	it("renders the research icon (type-research) before the project name", async () => {
		el.projects = [{ path: "/a", name: "Alpha", type: "research", sessionCount: 2, available: true }];
		await el.updateComplete;
		await openDropdown(el);

		const item = el.querySelector<HTMLElement>(".project-item")!;
		const icon = item.querySelector<HTMLElement>(".workspace-type-icon")!;
		expect(icon).not.toBeNull();
		expect(icon.classList.contains("type-research")).toBe(true);
		// Icon is rendered before the project name
		expect(item.firstElementChild).toBe(icon);
		expect(item.textContent).toContain("Alpha");
		// Lucide SVG inside
		expect(icon.querySelector("svg")).not.toBeNull();
	});

	// TC-F-3.7-2: unknown type renders the question-mark icon with class type-unknown
	it("renders the unknown icon (type-unknown) for an unknown type", async () => {
		el.projects = [{ path: "/b", name: "Beta", type: "unknown", sessionCount: 0, available: true }];
		await el.updateComplete;
		await openDropdown(el);

		const icon = el.querySelector<HTMLElement>(".project-item .workspace-type-icon")!;
		expect(icon).not.toBeNull();
		expect(icon.classList.contains("type-unknown")).toBe(true);
	});

	// All four types get their own icon class; unrecognized values fall back to unknown
	it("maps all four types (and unrecognized values) to their CSS classes", async () => {
		el.projects = [
			{ path: "/c", name: "C", type: "code", sessionCount: 0, available: true },
			{ path: "/r", name: "R", type: "research", sessionCount: 0, available: true },
			{ path: "/u", name: "U", type: "automation", sessionCount: 0, available: true },
			{ path: "/x", name: "X", type: "weird", sessionCount: 0, available: true },
		];
		await el.updateComplete;
		await openDropdown(el);

		const icons = Array.from(el.querySelectorAll<HTMLElement>(".project-item .workspace-type-icon"));
		expect(icons.length).toBe(4);
		expect(icons[0].classList.contains("type-code")).toBe(true);
		expect(icons[1].classList.contains("type-research")).toBe(true);
		expect(icons[2].classList.contains("type-automation")).toBe(true);
		expect(icons[3].classList.contains("type-unknown")).toBe(true);
	});

	// The trigger button also shows the current project's type icon
	it("shows the current project's type icon in the trigger button", async () => {
		el.projects = [{ path: "/a", name: "Alpha", type: "automation", sessionCount: 1, available: true }];
		el.currentProject = "/a";
		await el.updateComplete;

		const trigger = el.querySelector<HTMLElement>(".switcher-trigger")!;
		const icon = trigger.querySelector<HTMLElement>(".workspace-type-icon")!;
		expect(icon).not.toBeNull();
		expect(icon.classList.contains("type-automation")).toBe(true);
	});
});

describe("fan-project-switcher manual type change (F-3.10)", () => {
	let el: FanProjectSwitcher;

	beforeEach(() => {
		el = createEl();
	});

	afterEach(() => {
		el.remove();
	});

	// Each project row has an edit (pencil) button that opens the inline type editor
	it("opens the inline type editor with all four type options when the edit button is clicked", async () => {
		el.projects = [{ path: "/a", name: "Alpha", type: "unknown", sessionCount: 1, available: true }];
		await el.updateComplete;
		await openDropdown(el);

		expect(el.querySelector(".type-picker")).toBeNull();

		const btn = el.querySelector<HTMLButtonElement>(".project-type-edit-btn")!;
		expect(btn).not.toBeNull();
		btn.click();
		await el.updateComplete;

		const picker = el.querySelector<HTMLElement>(".type-picker")!;
		expect(picker).not.toBeNull();
		const options = Array.from(picker.querySelectorAll<HTMLButtonElement>(".type-option"));
		expect(options.map((o) => o.dataset.type)).toEqual(["code", "research", "automation", "unknown"]);
	});

	// Picking a type emits project-update-type (not project-select); the PUT is
	// performed by the app shell
	it("emits project-update-type (not project-select) when a type option is picked", async () => {
		el.projects = [{ path: "/a", name: "Alpha", type: "unknown", sessionCount: 1, available: true }];
		await el.updateComplete;
		await openDropdown(el);

		const updateEvents: CustomEvent[] = [];
		const selectEvents: CustomEvent[] = [];
		el.addEventListener("project-update-type", (e) => updateEvents.push(e as CustomEvent));
		el.addEventListener("project-select", (e) => selectEvents.push(e as CustomEvent));

		el.querySelector<HTMLButtonElement>(".project-type-edit-btn")!.click();
		await el.updateComplete;

		const researchBtn = el.querySelector<HTMLButtonElement>('.type-option[data-type="research"]')!;
		researchBtn.click();
		await el.updateComplete;

		expect(updateEvents.length).toBe(1);
		expect(updateEvents[0].detail).toEqual({ path: "/a", type: "research" });
		expect(updateEvents[0].bubbles).toBe(true);
		expect(updateEvents[0].composed).toBe(true);
		expect(selectEvents.length).toBe(0);
		// Editor row closes after the pick; the dropdown stays open
		expect(el.querySelector(".type-picker")).toBeNull();
		expect(el.querySelector(".fan-dropdown-panel")).not.toBeNull();
	});

	// Clicking the edit button again closes the editor without emitting
	it("toggles the editor closed on a second edit-button click", async () => {
		el.projects = [{ path: "/a", name: "Alpha", type: "unknown", sessionCount: 1, available: true }];
		await el.updateComplete;
		await openDropdown(el);

		const btn = el.querySelector<HTMLButtonElement>(".project-type-edit-btn")!;
		btn.click();
		await el.updateComplete;
		expect(el.querySelector(".type-picker")).not.toBeNull();

		btn.click();
		await el.updateComplete;
		expect(el.querySelector(".type-picker")).toBeNull();
	});

	// The edit button does not select the project
	it("does not emit project-select when the edit button is clicked", async () => {
		el.projects = PROJECTS;
		await el.updateComplete;
		await openDropdown(el);

		const selectEvents: CustomEvent[] = [];
		el.addEventListener("project-select", (e) => selectEvents.push(e as CustomEvent));

		el.querySelector<HTMLButtonElement>(".project-type-edit-btn")!.click();
		await el.updateComplete;

		expect(selectEvents.length).toBe(0);
	});
});
