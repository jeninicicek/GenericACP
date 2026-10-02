import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { chatMessagesToResponseInput, streamResponses, type ResponsesTextFormat } from "../../src/openai/responses.js";
import type { StreamDelta } from "../../src/openai/streaming.js";

describe("chatMessagesToResponseInput", () => {
  it("keeps assistant text that was sent with tool calls", () => {
    const input = chatMessagesToResponseInput([
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "I'll read the file.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "hello" },
    ]);

    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "read it" }] },
      { role: "assistant", content: [{ type: "input_text", text: "I'll read the file." }] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: "{\"path\":\"a.ts\"}",
      },
      { type: "function_call_output", call_id: "call_1", output: "hello" },
    ]);
  });

  it("omits an empty assistant message when the turn is only tool calls", () => {
    const input = chatMessagesToResponseInput([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
    ]);

    expect(input).toEqual([
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
    ]);
  });
});

const textFormat: ResponsesTextFormat = {
  type: "json_schema",
  name: "generic_acp_output",
  strict: true,
  schema: { type: "object" },
};

function completedStream(): AsyncGenerator<unknown> {
  return (async function* () {
    yield { type: "response.output_text.delta", delta: "ok" };
    yield { type: "response.completed", response: { output: [], status: "completed" } };
  })();
}

async function collect(gen: AsyncGenerator<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const delta of gen) {
    out.push(delta);
  }
  return out;
}

describe("streamResponses text format", () => {
  it("sends responseSchema as text.format", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      responses: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          calls.push(body);
          return completedStream();
        }),
      },
    } as unknown as OpenAI;

    await collect(streamResponses(client, "mock", [], [], new AbortController().signal, textFormat));
    expect(calls[0]?.text).toEqual({ format: textFormat });
  });

  it("does not retry auth failures without the schema", async () => {
    const error = new OpenAI.AuthenticationError(401, { message: "nope" }, "nope", new Headers());
    const create = vi.fn().mockRejectedValue(error);
    const client = { responses: { create } } as unknown as OpenAI;
    await expect(
      collect(streamResponses(client, "mock", [], [], new AbortController().signal, textFormat)),
    ).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries without text.format when the schema is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (body: Record<string, unknown>) => {
      calls.push(body);
      if (body.text) {
        throw new OpenAI.BadRequestError(
          400,
          { message: "json_schema is not supported" },
          "json_schema is not supported",
          new Headers(),
        );
      }
      return completedStream();
    });
    try {
      await collect(
        streamResponses({ responses: { create } } as unknown as OpenAI, "mock", [], [], new AbortController().signal, textFormat),
      );
      expect(calls).toHaveLength(2);
      expect(calls[1]?.text).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
