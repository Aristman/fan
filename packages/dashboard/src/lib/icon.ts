// @fan/dashboard/lib — shared icon helper for Lucide SVGs in Lit templates

import { html } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { IconNode } from "lucide";

/**
 * Serialize a Lucide IconNode (array of [tag, attrs] tuples) into an SVG string.
 * The root <svg> element with standard Lucide attributes is added automatically.
 */
function iconNodeToSvg(node: IconNode): string {
  const elements = node.map((el) => {
    const tag = el[0] as string;
    const attrs = el[1] as Record<string, string>;
    const attrStr = Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    return `<${tag}${attrStr ? " " + attrStr : ""}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${elements.join("")}</svg>`;
}

/**
 * Render a Lucide icon inside an inline-flex span.
 *
 * @param iconNode  Icon value exported from the `lucide` package (e.g. `Send`)
 * @param className Tailwind size / utility classes. Defaults to `w-4 h-4`.
 */
export function icon(iconNode: IconNode, className = "w-4 h-4"): ReturnType<typeof html> {
  return html`<span class="inline-flex items-center justify-center shrink-0 ${className}" .innerHTML=${unsafeSVG(iconNodeToSvg(iconNode))}></span>`;
}
