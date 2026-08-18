/**
 * Output renderers.
 *
 * Two formats and no more. `text` prints what the tool's own `render` derived,
 * which is the same prose an MCP client sees; `json` prints the structured
 * result and nothing else, for piping into something. A third, prettier format
 * would be a third thing to keep in step with the tools.
 */
import type { ToolResult } from '../server/tool.js';

/** The rendered text of a result: its text blocks, in order. */
export function renderedText(result: ToolResult): string {
  return result.content.map((block) => block.text).join('\n');
}

export function renderJson(result: ToolResult): string {
  return `${JSON.stringify(result.structuredContent ?? {}, null, 2)}\n`;
}
