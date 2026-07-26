// Tests for <fan-create-project-dialog> (F-3.8)
import type { CreateProjectResponse } from "@fan/api-gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FanApiClient, FanApiError } from "../api/client.js";
import "../components/create-project-dialog.js";
import { FanCreateProjectDialog } from "../components/create-project-dialog.js";

function stubClient(createProjectImpl?: () => Promise<CreateProjectResponse>): FanApiClient {
	return {
		createProject: vi.fn(createProjectImpl ?? (() => Promise.resolve({
			path: "/tmp/MyProj",
			name: "MyProj",
			type: "code",
			template: "code",
		}))),
	} as unknown as FanApiClient;
}

function openDialog(client: FanApiClient): FanCreateProjectDialog {
	return FanCreateProjectDialog.open(client);
}

function setName(el: FanCreateProjectDialog, name: string): void {
	const input = el.querySelector<HTMLInputElement>(".project-name-input")!;
	input.value = name;
	input.dispatchEvent(new Event("input"));
}

function selectTemplate(el: FanCreateProjectDialog, value: string): void {
	const radio = el.querySelector<HTMLInputElement>(`.template-radio[value="${value}"]`)!;
	radio.checked = true;
	radio.dispatchEvent(new Event("change"));
}

async function submit(el: FanCreateProjectDialog): Promise<void> {
	el.querySelector<HTMLButtonElement>(".create-btn")!.click();
	// Let the async submit() (microtasks) settle and the component re-render
	await vi.waitFor(() => {
		expect(el.submitting).toBe(false);
	});
	await el.updateComplete;
}

describe("fan-create-project-dialog", () => {
	let el: FanCreateProjectDialog | undefined;
	let client: FanApiClient;

	beforeEach(() => {
		client = stubClient();
	});

	afterEach(() => {
		el?.remove();
		el = undefined;
	});

	// TC-F-3.8-1: the dialog renders all four template radio options
	it("renders 4 template radio options: Code, Research, Automation, Empty folder", async () => {
		el = openDialog(client);
		await el.updateComplete;

		const radios = el.querySelectorAll<HTMLInputElement>(".template-radio");
		expect(radios.length).toBe(4);

		const values = Array.from(radios).map((r) => r.value);
		expect(values).toEqual(["code", "research", "automation", ""]);

		const text = el.textContent ?? "";
		expect(text).toContain("Code Project");
		expect(text).toContain("Research Lab");
		expect(text).toContain("Automation Hub");
		expect(text).toContain("Empty Folder");
	});

	// TC-F-3.8-2: submit sends the correct payload; dialog closes on success
	it("submits POST body { name, template, rootPath } and closes on success", async () => {
		el = openDialog(client);
		await el.updateComplete;

		const events: CustomEvent[] = [];
		el.addEventListener("project-created", (e) => events.push(e as CustomEvent));

		setName(el, "MyProj");
		selectTemplate(el, "research");
		const rootInput = el.querySelector<HTMLInputElement>(".root-path-input")!;
		rootInput.value = "/tmp";
		rootInput.dispatchEvent(new Event("input"));
		await el.updateComplete;

		await submit(el);

		expect(client.createProject).toHaveBeenCalledTimes(1);
		expect(client.createProject).toHaveBeenCalledWith({
			name: "MyProj",
			template: "research",
			rootPath: "/tmp",
		});

		// Success event fired, then the dialog closed (removed from the DOM)
		expect(events.length).toBe(1);
		expect(events[0].detail).toEqual({
			path: "/tmp/MyProj",
			name: "MyProj",
			type: "code",
			template: "code",
		});
		expect(events[0].bubbles).toBe(true);
		expect(events[0].composed).toBe(true);
		expect(el.isConnected).toBe(false);
		const elRef = el;
		el = undefined;
		expect(document.body.contains(elRef)).toBe(false);
	});

	// Empty folder = no template field in the request body
	it("omits template from the payload when 'Empty Folder' is selected", async () => {
		el = openDialog(client);
		await el.updateComplete;

		setName(el, "plain");
		selectTemplate(el, "");
		await el.updateComplete;
		await submit(el);

		expect(client.createProject).toHaveBeenCalledWith({ name: "plain" });
	});

	// Empty name → create button disabled
	it("disables the Create button while the name is empty", async () => {
		el = openDialog(client);
		await el.updateComplete;

		const btn = el.querySelector<HTMLButtonElement>(".create-btn")!;
		expect(btn.disabled).toBe(true);

		setName(el, "something");
		await el.updateComplete;
		expect(btn.disabled).toBe(false);
	});

	// Traversal symbols in the name → inline error + disabled submit
	it("shows an error and disables submit for traversal symbols in the name", async () => {
		el = openDialog(client);
		await el.updateComplete;

		setName(el, "../escape");
		await el.updateComplete;

		const err = el.querySelector(".name-error");
		expect(err).not.toBeNull();
		expect(err!.textContent).toContain("single path segment");
		expect(el.querySelector(".project-name-input")!.classList.contains("name-invalid")).toBe(true);
		expect(el.querySelector<HTMLButtonElement>(".create-btn")!.disabled).toBe(true);
	});

	// Server error (403) is shown inline; the dialog stays open
	it("shows a 403 server error message and keeps the dialog open", async () => {
		client = stubClient(() => Promise.reject(new FanApiError(403, "FORBIDDEN", "path rejected: outside allowed roots")));
		el = openDialog(client);
		await el.updateComplete;

		setName(el, "MyProj");
		await el.updateComplete;
		await submit(el);

		const errBox = el.querySelector(".dialog-error");
		expect(errBox).not.toBeNull();
		expect(errBox!.textContent).toContain("path rejected: outside allowed roots");
		expect(errBox!.textContent).toContain("403");
		expect(el.isConnected).toBe(true);
	});

	// Server error (400, e.g. unknown template) is shown inline as well
	it("shows a 400 server error message", async () => {
		client = stubClient(() => Promise.reject(new FanApiError(400, "BAD_REQUEST", "Unknown template: weird")));
		el = openDialog(client);
		await el.updateComplete;

		setName(el, "MyProj");
		await el.updateComplete;
		await submit(el);

		expect(el.querySelector(".dialog-error")!.textContent).toContain("Unknown template: weird");
		expect(el.isConnected).toBe(true);
	});

	// Cancel closes the dialog without submitting
	it("closes without submitting when Cancel is clicked", async () => {
		el = openDialog(client);
		await el.updateComplete;

		el.querySelector<HTMLButtonElement>(".cancel-btn")!.click();
		expect(el.isConnected).toBe(false);
		expect(client.createProject).not.toHaveBeenCalled();
		el = undefined;
	});
});
