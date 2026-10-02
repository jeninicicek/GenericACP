# 05 — Image / Audio Content Blocks

## Status

Implemented and verified end-to-end against a mock provider over stdio (`scripts/test-image-content.ts`). Audio remains `audio: false` per requirement 3.

## Implemented

### 1. Advertise Image Support

`src/acp/agent.ts` `initialize()` now advertises `promptCapabilities`:

```typescript
promptCapabilities: {
  image: true,    // was: false — driven by config `imageSupport`
  audio: false,   // keep false unless we add audio support
  embeddedContext: true,
}
```

Turning `imageSupport` off makes the agent both advertise `image: false` and not send images.

### 2. Image Content Block Handling

`src/acp/content.ts` gains `contentBlocksToMessageContent(blocks): string | ChatCompletionContentPart[]` (imported from `openai/resources/chat/completions`).

- `text` → `{ type: "text", text }`
- `image` → `{ type: "image_url", image_url: { url: \`data:${block.mimeType};base64,${block.data}\` } }`
  — the ACP SDK `ImageContent` always carries `data` + `mimeType`; `uri` is optional, so the data-URL form is always available.
- `resource_link` → `{ type: "text", text: \`[${block.name}](${block.uri})\` }`
- `resource` → `{ type: "text", text: block.resource.text }` when the resource has text
- Block order is preserved: interleaved text is coalesced into `{type:"text"}` parts up to the next non-text block, so a text-before-image-before-text prompt stays ordered.
- A pure-text prompt returns a plain `string` (backward compatible with session history).

`src/acp/agent.ts` `prompt()` builds the user message with `contentBlocksToMessageContent()` when image support is enabled, else falls back to `contentBlocksToText()` for non-vision mode.

`src/openai/streaming.ts` needed **no change**: `ChatCompletionMessageParam["content"]` already accepts `string | ChatCompletionContentPart[]`, so multi-part content flows straight through.

`src/config/config.ts` adds `imageSupport?: boolean` (default `true`) with env override `GENERIC_ACP_SUPPORT_IMAGES` (`"true"` / `"false"`). Mirrors the `apiMode` config pattern; the "fall back if the model doesn't support vision" requirement is met by flipping this switch rather than sniffing provider error strings.

`src/openai/responses.ts` `contentToResponseInputContent()` maps parts for Responses mode too: `text` → `{ type: "input_text", text }`, `image_url` → `{ type: "input_image", image_url, detail: "auto" }`.

### 3. Audio Content Blocks

`audioSupport` defaults to false, so `initialize` still advertises `audio: false` until config `audioSupport` or `GENERIC_ACP_AUDIO=true`. When on, `src/acp/content.ts` maps ACP audio (`data` + `mimeType`) to OpenAI `input_audio` for `audio/wav` and `audio/mpeg`. Other types become a text note. A provider error that mentions audio is retried once with that note (`src/openai/streaming.ts`).

## Verification

`scripts/test-image-content.ts` (permanent, run with `npx tsx`) drives the built agent over stdio with an in-process mock provider:

- **Scenario A (chat-completions):** `initialize.image === true`; user message is a part array with the text part plus `image_url` = `data:image/png;base64,iVBORw0KGgo=`; text streams back.
- **Scenario B (`GENERIC_ACP_SUPPORT_IMAGES=false`):** `initialize.image === false`; user message flattened to `"Describe this image:"` (image dropped).
- **Scenario C (apiMode=responses):** user content sent as `input_text` + `input_image` (`detail: "auto"`); text streams back from mock Responses SSE.
- MCP bridge regressions (`scripts/test-mcp-bridge.ts`, `scripts/test-failure.ts`) still pass.
- `npm run typecheck` and `npm run build` pass.

## Testing Strategy (future)

1. **Unit test:** create content blocks with image data; verify they produce correct `image_url` parts (currently covered by the e2e script's assertions)
2. **Integration test:** send a prompt with an embedded image against a real vision-capable model (e.g. GPT-4o) — deferred to task 6 (Real-world Validation)
3. **Manual test:** run against OpenAI or another vision model with an image in the prompt

## Acceptance Criteria

- [x] `image: true` is advertised in `initialize`
- [x] Image content blocks are converted to OpenAI `image_url` format
- [x] Multi-part content (text + image) is sent correctly to the provider
- [x] Text-only prompts still work (backward compatible)
- [x] `contentBlocksToText()` is preserved for non-vision use cases
- [x] `npm run typecheck` passes