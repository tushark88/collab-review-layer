import type { Disposition } from "../domain.ts";
import type { JsonTransport } from "./http.ts";
import type { SearchContext, TrackerWebhook, WorkContainer, WorkItem, WorkItemDraft, WorkTracker } from "../tracker.ts";
import { requireDeliveryId, requireWebhookBody, verifyHmacSha256 } from "../webhook.ts";

export interface GitHubConfig { endpoint: string; token: string; webhookSecret: string; owner: string; repository: string; }

export class GitHubIssuesTracker implements WorkTracker {
  readonly provider = "github" as const;
  readonly config: GitHubConfig;
  readonly transport: JsonTransport;
  constructor(config: GitHubConfig, transport: JsonTransport) { this.config = config; this.transport = transport; }
  async findOrCreateContainer(input: { workspaceId: string; name: string }): Promise<WorkContainer> {
    await this.transport.request({ method: "GET", url: `${this.config.endpoint}/repos/${this.config.owner}/${this.config.repository}`, headers: this.headers() });
    return { provider: this.provider, id: `${this.config.owner}/${this.config.repository}`, workspaceId: input.workspaceId, name: input.name };
  }
  async candidates(context: SearchContext): Promise<readonly WorkItem[]> {
    const query = encodeURIComponent(
      `repo:${this.config.owner}/${this.config.repository} is:issue in:body ${searchPhrase(context.route)} ${searchPhrase(context.anchorFingerprint)}`,
    );
    const data = await this.transport.request<{ items: Array<{ number: number; html_url: string; title: string; body?: string; state: string; labels: Array<{ name: string }>; updated_at: string }> }>({ method: "GET", url: `${this.config.endpoint}/search/issues?q=${query}`, headers: this.headers() });
    return data.items.map((item) => ({ provider: this.provider, id: String(item.number), url: item.html_url, title: item.title, body: item.body ?? "", state: item.state === "closed" ? "closed" : "open", containerId: `${this.config.owner}/${this.config.repository}`, repository: `${this.config.owner}/${this.config.repository}`, labels: item.labels.map((label) => label.name), updatedAt: item.updated_at }));
  }
  async createItem(container: WorkContainer, draft: WorkItemDraft): Promise<WorkItem> {
    const item = await this.transport.request<{ number: number; html_url: string; title: string; body: string; state: string; labels: Array<{ name: string }>; updated_at: string }>({ method: "POST", url: `${this.config.endpoint}/repos/${this.config.owner}/${this.config.repository}/issues`, headers: { ...this.headers(), "x-idempotency-key": draft.idempotencyKey }, body: { title: draft.title, body: draft.body, labels: draft.labels } });
    return { provider: this.provider, id: String(item.number), url: item.html_url, title: item.title, body: item.body, state: "open", containerId: container.id, repository: container.id, labels: item.labels.map((label) => label.name), updatedAt: item.updated_at };
  }
  async addComment(itemId: string, body: string, idempotencyKey: string): Promise<void> { await this.transport.request({ method: "POST", url: `${this.config.endpoint}/repos/${this.config.owner}/${this.config.repository}/issues/${itemId}/comments`, headers: { ...this.headers(), "x-idempotency-key": idempotencyKey }, body: { body } }); }
  async applyDisposition(itemId: string, disposition: Disposition, reason?: string): Promise<void> {
    if (disposition === "accepted") return;
    await this.transport.request({ method: "PATCH", url: `${this.config.endpoint}/repos/${this.config.owner}/${this.config.repository}/issues/${itemId}`, headers: this.headers(), body: { state: "closed", state_reason: disposition === "rejected" ? "not_planned" : "completed" } });
    if (reason) await this.addComment(itemId, `Disposition reason: ${reason}`, `disposition:${disposition}`);
  }
  async parseAndVerifyWebhook(body: Uint8Array, headers: Readonly<Record<string, string>>): Promise<TrackerWebhook> {
    requireWebhookBody(body);
    if (!verifyHmacSha256(body, headers["x-hub-signature-256"], this.config.webhookSecret)) throw new Error("invalid GitHub webhook signature");
    const raw = JSON.parse(new TextDecoder().decode(body)) as { issue?: { number?: number }; comment?: { body?: string } };
    return { deliveryId: requireDeliveryId(headers["x-github-delivery"]), event: headers["x-github-event"] ?? "unknown", workItemId: raw.issue?.number === undefined ? undefined : String(raw.issue.number), commentBody: raw.comment?.body, raw };
  }
  private headers(): Record<string, string> { return { authorization: `Bearer ${this.config.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }; }
}

function searchPhrase(value: string): string {
  const literal = value.replace(/["\\\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return `"${literal}"`;
}
