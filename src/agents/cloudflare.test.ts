import { describe, expect, it, vi } from "vitest";

import { CloudflareWorkersAIClient, cloudflareBaseUrl } from "./cloudflare.js";
import { PermanentAgentError } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CloudflareWorkersAIClient", () => {
  it("builds the OpenAI-compatible account URL", () => {
    expect(cloudflareBaseUrl("acc123")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1",
    );
  });

  it("requires credentials", () => {
    expect(
      () =>
        new CloudflareWorkersAIClient({
          accountId: "",
          apiToken: "t",
          model: "m",
        }),
    ).toThrow(PermanentAgentError);
  });

  it("posts to chat/completions and maps usage", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '{"success":true}' } }],
        usage: { prompt_tokens: 42, completion_tokens: 17 },
      }),
    );
    const client = new CloudflareWorkersAIClient({
      accountId: "acc",
      apiToken: "tok",
      model: "@cf/moonshotai/kimi-k2.7-code",
      fetch: fetchFn as unknown as typeof fetch,
    });

    const result = await client.chatCompletion({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe('{"success":true}');
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(17);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toContain("/accounts/acc/ai/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
  });

  it("throws a permanent error on 401", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = new CloudflareWorkersAIClient({
      accountId: "acc",
      apiToken: "bad",
      model: "m",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(
      client.chatCompletion({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(PermanentAgentError);
  });

  it("marks 503 as retryable", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const client = new CloudflareWorkersAIClient({
      accountId: "acc",
      apiToken: "tok",
      model: "m",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(
      client.chatCompletion({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ retryable: true });
  });
});
