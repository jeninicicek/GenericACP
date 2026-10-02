import type { ContentBlock, Range } from "@agentclientprotocol/sdk";

export interface OpenDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  focused: boolean;
}

export class DocumentStore {
  private readonly docs = new Map<string, OpenDocument>();

  open(uri: string, languageId: string, version: number, text: string): void {
    const focused = this.docs.get(uri)?.focused ?? false;
    this.docs.set(uri, { uri, languageId, version, text, focused });
  }

  change(uri: string, version: number, changes: Array<{ range?: Range | null; text: string }>): void {
    const doc = this.docs.get(uri);
    if (!doc) return;
    let text = doc.text;
    for (const change of changes) {
      text = change.range ? replaceRange(text, change.range, change.text) : change.text;
    }
    doc.text = text;
    doc.version = version;
  }

  close(uri: string): void {
    this.docs.delete(uri);
  }

  focus(uri: string, version: number): void {
    for (const doc of this.docs.values()) {
      doc.focused = doc.uri === uri;
      if (doc.uri === uri) doc.version = version;
    }
  }

  contextBlocks(): ContentBlock[] {
    if (this.docs.size === 0) return [];
    const body = Array.from(this.docs.values())
      .map((doc) => `### ${doc.uri}${doc.focused ? " (focused)" : ""}\n${doc.text}`)
      .join("\n\n");
    return [{ type: "text", text: `Open documents:\n${body}` }];
  }
}

function replaceRange(text: string, range: Range, insert: string): string {
  const start = offsetAt(text, range.start.line, range.start.character);
  const end = offsetAt(text, range.end.line, range.end.character);
  return text.slice(0, start) + insert + text.slice(end);
}

function offsetAt(text: string, line: number, character: number): number {
  let index = 0;
  let current = 0;
  while (current < line && index < text.length) {
    const next = text.indexOf("\n", index);
    if (next < 0) return text.length;
    index = next + 1;
    current += 1;
  }
  return Math.min(text.length, index + character);
}
