// Test-only stand-in for a web extension such as pi-web-access: registers a `web_search` tool.
export default function (pi: { registerTool: (tool: Record<string, unknown>) => void }) {
  pi.registerTool({
    name: "web_search", label: "Web search", description: "Search the web (test stand-in).",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async execute(_id: string, params: { query: string }) { return { content: [{ type: "text", text: `WEB-RESULT for ${params.query}` }], details: {} }; },
  });
}
