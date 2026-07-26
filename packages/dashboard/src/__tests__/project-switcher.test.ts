// Tests for <fan-project-switcher> (F-2.6)
import type { ProjectSummary } from "@fan/api-gateway/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../components/project-switcher.js";
import type { FanProjectSwitcher } from "../components/project-switcher.js";

const PROJECTS: ProjectSummary[] = [
	{ path: "/a", name: "Alpha", type: "unknown", sessionCount: 2 },
	{ path: "/b", name: "Beta", type: "unknown", sessionCount: 5 },
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

	// "+" button opens the inline form; submit emits project-add
	it("opens the inline add form via '+' and emits project-add with the entered path", async () => {
		el.projects = PROJECTS;
		await el.updateComplete;
		await openDropdown(el);

		// Form not visible initially
		expect(el.querySelector(".add-form")).toBeNull();

		el.querySelector<HTMLButtonElement>(".add-project-btn")!.click();
		await el.updateComplete;

		const form = el.querySelector<HTMLFormElement>(".add-form");
		expect(form).not.toBeNull();

		const events: CustomEvent[] = [];
		el.addEventListener("project-add", (e) => events.push(e as CustomEvent));

		const input = el.querySelector<HTMLInputElement>(".new-path-input")!;
		input.value = "/new/proj";
		input.dispatchEvent(new Event("input"));
		await el.updateComplete;

		form!.requestSubmit();
		await el.updateComplete;

		expect(events.length).toBe(1);
		expect(events[0].detail).toEqual({ path: "/new/proj" });
		expect(events[0].bubbles).toBe(true);
		expect(events[0].composed).toBe(true);

		// Form collapses after submit
		expect(el.querySelector(".add-form")).toBeNull();
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
});
