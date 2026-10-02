import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentIntegrationsPanel } from "./AgentIntegrationsPanel";
import { CustomerMemoryPanel } from "./CustomerMemoryPanel";
const j = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
describe("real integration controls", () => {
  it("shows default-off readiness and does not offer activation without a trusted binding", async () => {
    const fetch = vi.fn(async () => j({ data: { providers: ["mem0", "weknora", "langfuse"].map((provider) => ({ provider, configured: false, enabled: false, revision: 0 })), trace_delivery: [], cleanup_receipts: [] } }));
    vi.stubGlobal("fetch", fetch);
    render(<AgentIntegrationsPanel />);
    expect(await screen.findByText("mem0")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "启用" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("same-content retry preserves the customer fact key after an ambiguous result", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "POST") { posts.push(JSON.parse(init.body)); return j({ error: { message: "保存结果未确认，请按相同键重试" } }, 503); }
      return j({ data: [] });
    }));
    render(<CustomerMemoryPanel contactId="a0000000-0000-4000-8000-000000000001" />);
    const input = screen.getByRole("textbox", { name: "已确认的记忆内容" });
    fireEvent.change(input, { target: { value: "Prefers email" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "确认并保存" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]!.request_key).toBe(posts[1]!.request_key);
    expect(posts[0]).toMatchObject({ confirmed: true, category: "preference", body: "Prefers email" });
  });
});
