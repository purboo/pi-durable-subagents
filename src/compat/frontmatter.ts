function fold(block: string): string {
  let result = "", previousIndented = false, blanks = 0;
  for (const line of block.split("\n")) {
    const text = line.trimEnd();
    if (!text.trim()) { if (result) blanks++; continue; }
    const indented = text !== text.trimStart();
    if (result) result += blanks ? "\n".repeat(blanks + (previousIndented || indented ? 1 : 0)) : previousIndented || indented ? "\n" : " ";
    result += text;
    previousIndented = indented;
    blanks = 0;
  }
  return result.trim();
}

/** P35: Mirror upstream frontmatter.js:61–144 simple scalars, blocks and CRLF handling. */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = Object.create(null);
  const text = content.replace(/\r\n/g, "\n");
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end < 0) return { frontmatter, body: text };
  let key: string | undefined, block: string[] = [], folded = false, literal = false;
  const flush = () => {
    if (key === undefined) return;
    const raw = block.join("\n");
    const prefix = raw.match(/^[ \t]+(?=\S)/m)?.[0];
    const stripped = prefix ? raw.split("\n").map(line => line.startsWith(prefix) ? line.slice(prefix.length) : line).join("\n").replace(/^\n/, "") : raw;
    frontmatter[key] = folded ? fold(stripped) : stripped;
    key = undefined; block = []; folded = false; literal = false;
  };
  for (const line of text.slice(4, end).split("\n")) {
    if (key !== undefined && (line.search(/\S|$/) > 0 || ((folded || literal) && !line.trim()))) { block.push(line); continue; }
    flush();
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    const raw = match[2]!.trim();
    const quoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
    const value = quoted ? raw.slice(1, -1) : raw;
    folded = !quoted && (raw === ">" || raw === ">-");
    literal = !quoted && (raw === "|" || raw === "|-");
    if (!value || folded || literal) key = match[1]!;
    else frontmatter[match[1]!] = value;
  }
  flush();
  return { frontmatter, body: text.slice(end + 4).trim() };
}

/** P35: Mirror upstream frontmatter.js:42–54 comma and block lists (not full YAML). */
export function parseFrontmatterList(raw: string | undefined): string[] | undefined {
  return raw?.split("\n").flatMap(line => (line.trim().match(/^-\s+(.+)$/)?.[1] ?? line.trim()).split(",")).map(s => s.trim()).filter(Boolean);
}
