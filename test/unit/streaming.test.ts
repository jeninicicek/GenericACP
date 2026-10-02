import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { streamChatCompletion, type ResponseFormat, type StreamDelta } from "../../src/openai/streaming.js";

const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "hi" }];
const format: ResponseFormat = {
  type: "json_schema",
  json_schema: { name: "generic_acp_output", strict: true, schema: { type: "object" } },
};

function okStream(): AsyncGenerator<unknown> {
  return (async function* () {
    yield {
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
    };
  })();
}

async function collect(gen: AsyncGenerator<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const delta of gen) {
    out.push(delta);
  }
  return out;
}

function clientWith(create: ReturnType<typeof vi.fn>) {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

describe("streamChatCompletion retries", () => {
  it("fails once on auth, network, and 5xx errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases = [
      new OpenAI.AuthenticationError(401, { message: "nope" }, "nope", new Headers()),
      new OpenAI.APIConnectionError({ message: "reset" }),
      new OpenAI.APIError(500, { message: "down" }, "down", new Headers()),
    ];

    try {
      for (const error of cases) {
        const create = vi.fn().mockRejectedValue(error);
        const client = clientWith(create);
        await expect(
          collect(streamChatCompletion(client, "mock", messages, [], new AbortController().signal, format)),
        ).rejects.toBe(error);
        expect(create).toHaveBeenCalledTimes(1);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("drops include_usage and keeps response_format when usage is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (body: Record<string, unknown>) => {
      calls.push(body);
      if (body.stream_options) {
        throw new OpenAI.BadRequestError(
          400,
          { message: "unknown parameter stream_options" },
          "unknown parameter stream_options",
          new Headers(),
        );
      }
      return okStream();
    });

    try {
      const deltas = await collect(
        streamChatCompletion(clientWith(create), "mock", messages, [], new AbortController().signal, format),
      );
      expect(deltas).toEqual([
        { type: "text", text: "hi" },
        { type: "done", finishReason: "stop" },
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.response_format).toEqual(format);
      expect(calls[0]?.stream_options).toEqual({ include_usage: true });
      expect(calls[1]?.response_format).toEqual(format);
      expect(calls[1]?.stream_options).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("drops response_format and keeps include_usage when the schema is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (body: Record<string, unknown>) => {
      calls.push(body);
      if (body.response_format) {
        throw new OpenAI.BadRequestError(
          400,
          { message: "response_format is not supported" },
          "response_format is not supported",
          new Headers(),
        );
      }
      return okStream();
    });

    try {
      await collect(streamChatCompletion(clientWith(create), "mock", messages, [], new AbortController().signal, format));
      expect(calls).toHaveLength(2);
      expect(calls[1]?.response_format).toBeUndefined();
      expect(calls[1]?.stream_options).toEqual({ include_usage: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("drops usage before format when a 400 does not name the parameter", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (body: Record<string, unknown>) => {
      calls.push(body);
      if (calls.length === 1) {
        throw new OpenAI.BadRequestError(400, { message: "bad request" }, "bad request", new Headers());
      }
      return okStream();
    });

    try {
      await collect(streamChatCompletion(clientWith(create), "mock", messages, [], new AbortController().signal, format));
      expect(calls).toHaveLength(2);
      expect(calls[1]?.response_format).toEqual(format);
      expect(calls[1]?.stream_options).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
