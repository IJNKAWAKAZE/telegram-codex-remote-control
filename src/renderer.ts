const MAX_MESSAGE_LENGTH = 3500;

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderStatusMessage(input: {
  state: string;
  cwd: string;
  statusLines: string[];
  commandLines: string[];
}) {
  const lines = [`<b>${escapeHtml(input.state)}</b>`, `<code>cwd: ${escapeHtml(input.cwd)}</code>`];

  if (input.statusLines.length) {
    lines.push("", ...input.statusLines.map((line) => `• ${escapeHtml(line)}`));
  }

  if (input.commandLines.length) {
    lines.push(
      "",
      "<b>Commands</b>",
      `<blockquote expandable>${input.commandLines.map((line) => `$ ${escapeHtml(line)}`).join("\n")}</blockquote>`
    );
  }

  return lines.join("\n");
}

export function renderBodyChunks(body: string) {
  if (!body) {
    return [];
  }

  const blocks = renderMarkdownBlocks(body);
  const chunks: string[] = [];
  let chunk = "";

  for (const block of blocks) {
    const separator = chunk ? "\n\n" : "";
    if (chunk && chunk.length + separator.length + block.length > MAX_MESSAGE_LENGTH) {
      chunks.push(chunk);
      chunk = block;
      continue;
    }

    chunk += `${separator}${block}`;
  }

  if (chunk) {
    chunks.push(chunk);
  }

  return chunks;
}

function renderMarkdownBlocks(markdown: string) {
  const blocks: string[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const fence = line.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length && lines[index]!.startsWith("```")) {
        index += 1;
      }
      blocks.push(...renderCodeBlockChunks(codeLines.join("\n"), fence));
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index]!.trimStart().startsWith(">")) {
        quoteLines.push(lines[index]!.replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderInline(quoteLines.join("\n")).replaceAll("\n", "<br>")}</blockquote>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!current.trim() || current.startsWith("```") || current.trimStart().startsWith(">")) {
        break;
      }
      paragraphLines.push(renderLine(current));
      index += 1;
    }

    if (paragraphLines.length) {
      blocks.push(paragraphLines.join("\n"));
    }
  }

  return blocks.length ? blocks : [escapeHtml(markdown)];
}

function renderLine(line: string) {
  const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (headingMatch) {
    return `<b>${renderInline(headingMatch[1] ?? "")}</b>`;
  }

  const unorderedListMatch = line.match(/^\s*[-*+]\s+(.+)$/);
  if (unorderedListMatch) {
    return `• ${renderInline(unorderedListMatch[1] ?? "")}`;
  }

  const orderedListMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
  if (orderedListMatch) {
    return `${orderedListMatch[1]}. ${renderInline(orderedListMatch[2] ?? "")}`;
  }

  return renderInline(line);
}

function renderInline(value: string) {
  const placeholders: string[] = [];
  let html = escapeHtml(value);

  html = html.replace(/`([^`\n]+)`/g, (_, code: string) => pushPlaceholder(placeholders, `<code>${code}</code>`));
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => {
    return pushPlaceholder(
      placeholders,
      `<a href="${escapeAttribute(url)}">${renderStyledText(label)}</a>`
    );
  });

  html = renderStyledText(html);

  for (let index = 0; index < placeholders.length; index += 1) {
    html = html.replaceAll(`\u0000${index}\u0000`, placeholders[index] ?? "");
  }

  return html;
}

function renderStyledText(value: string) {
  return value
    .replace(/\*\*([^*\n][\s\S]*?[^*\n]?)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n][\s\S]*?[^_\n]?)__/g, "<u>$1</u>")
    .replace(/\*([^*\n][\s\S]*?[^*\n]?)\*/g, "<i>$1</i>")
    .replace(/_([^_\n][\s\S]*?[^_\n]?)_/g, "<i>$1</i>")
    .replace(/~~([^~\n][\s\S]*?[^~\n]?)~~/g, "<s>$1</s>")
    .replace(/\|\|([^|\n][\s\S]*?[^|\n]?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
}

function renderCodeBlockChunks(code: string, language: string) {
  const chunks: string[] = [];
  const wrapperOpen = language
    ? `<pre><code class="language-${escapeAttribute(language)}">`
    : "<pre><code>";
  const wrapperClose = "</code></pre>";
  const lines = code.split("\n").map(escapeHtml);
  let chunk = "";

  for (const line of lines) {
    const next = chunk ? `${chunk}\n${line}` : line;
    if (wrapperOpen.length + next.length + wrapperClose.length > MAX_MESSAGE_LENGTH && chunk) {
      chunks.push(`${wrapperOpen}${chunk}${wrapperClose}`);
      chunk = line;
      continue;
    }

    if (wrapperOpen.length + next.length + wrapperClose.length > MAX_MESSAGE_LENGTH) {
      chunks.push(...splitLongCodeLine(line, wrapperOpen, wrapperClose));
      chunk = "";
      continue;
    }

    chunk = next;
  }

  if (chunk || !chunks.length) {
    chunks.push(`${wrapperOpen}${chunk}${wrapperClose}`);
  }

  return chunks;
}

function splitLongCodeLine(line: string, wrapperOpen: string, wrapperClose: string) {
  const chunks: string[] = [];
  const budget = Math.max(1, MAX_MESSAGE_LENGTH - wrapperOpen.length - wrapperClose.length);
  let offset = 0;

  while (offset < line.length) {
    const slice = line.slice(offset, offset + budget);
    chunks.push(`${wrapperOpen}${slice}${wrapperClose}`);
    offset += slice.length;
  }

  return chunks;
}

function pushPlaceholder(placeholders: string[], value: string) {
  const token = `\u0000${placeholders.length}\u0000`;
  placeholders.push(value);
  return token;
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
