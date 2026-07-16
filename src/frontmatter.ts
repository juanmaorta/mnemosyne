import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ParsedDocument {
  data: Record<string, unknown>;
  body: string;
}

const DELIMITER = "---";

export function parseFrontmatter(raw: string): ParsedDocument {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== DELIMITER) {
    return { data: {}, body: raw };
  }

  const closingIndex = lines.indexOf(DELIMITER, 1);
  if (closingIndex === -1) {
    return { data: {}, body: raw };
  }

  const yamlBlock = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n");
  const data = (parseYaml(yamlBlock) as Record<string, unknown> | null) ?? {};

  return { data, body };
}

export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlBlock = stringifyYaml(data);
  return `${DELIMITER}\n${yamlBlock}${DELIMITER}\n${body}`;
}
