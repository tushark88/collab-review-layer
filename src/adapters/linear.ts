import type { Disposition } from "../domain.ts";
import type { JsonTransport } from "./http.ts";
import type { SearchContext, TrackerWebhook, WorkContainer, WorkItem, WorkItemDraft, WorkTracker } from "../tracker.ts";
import { requireDeliveryId, requireFreshTimestamp, requireWebhookBody, verifyHmacSha256 } from "../webhook.ts";

export interface LinearConfig {
  endpoint: string;
  token: string;
  webhookSecret: string;
  teamId: string;
  now: () => number;
  dispositionStateIds: { accepted: string; rejected: string; implemented_verified: string };
}

export class LinearTracker implements WorkTracker {
  readonly provider = "linear" as const;
  readonly config: LinearConfig;
  readonly transport: JsonTransport;
  constructor(config: LinearConfig, transport: JsonTransport) { this.config = config; this.transport = transport; }

  async findOrCreateContainer(input: { workspaceId: string; name: string }): Promise<WorkContainer> {
    const data = await this.graphql<{ projects: { nodes: { id: string; name: string }[] } }>(`query($name:String!){projects(filter:{name:{eq:$name}}){nodes{id name}}}`, { name: input.name });
    const existing = data.projects.nodes[0];
    if (existing) return { provider: this.provider, id: existing.id, workspaceId: input.workspaceId, name: existing.name };
    const created = await this.graphql<{ projectCreate: { project: { id: string; name: string } } }>(`mutation($name:String!,$teamIds:[String!]!){projectCreate(input:{name:$name,teamIds:$teamIds}){project{id name}}}`, { name: input.name, teamIds: [this.config.teamId] });
    return { provider: this.provider, id: created.projectCreate.project.id, workspaceId: input.workspaceId, name: created.projectCreate.project.name };
  }

  async candidates(context: SearchContext): Promise<readonly WorkItem[]> {
    const data = await this.graphql<{ issueSearch: { nodes: Array<{ id: string; url: string; title: string; description?: string; state: { type: string }; project?: { id: string }; labels: { nodes: { name: string }[] }; updatedAt: string }> } }>(`query($term:String!){issueSearch(query:$term){nodes{id url title description updatedAt state{type} project{id} labels{nodes{name}}}}}`, { term: [context.route, context.anchorFingerprint, context.repository].filter(Boolean).join(" ") });
    return data.issueSearch.nodes.map((node) => ({ provider: this.provider, id: node.id, url: node.url, title: node.title, body: node.description ?? "", state: node.state.type === "completed" || node.state.type === "canceled" ? "closed" : "open", containerId: node.project?.id, labels: node.labels.nodes.map((label) => label.name), updatedAt: node.updatedAt }));
  }

  async createItem(container: WorkContainer, draft: WorkItemDraft): Promise<WorkItem> {
    const data = await this.graphql<{ issueCreate: { issue: { id: string; url: string; title: string; description: string; updatedAt: string } } }>(`mutation($input:IssueCreateInput!){issueCreate(input:$input){issue{id url title description updatedAt}}}`, { input: { teamId: this.config.teamId, projectId: container.id, title: draft.title, description: draft.body, labelIds: [] } });
    const issue = data.issueCreate.issue;
    return { provider: this.provider, id: issue.id, url: issue.url, title: issue.title, body: issue.description, state: "open", containerId: container.id, labels: draft.labels, updatedAt: issue.updatedAt };
  }

  async addComment(itemId: string, body: string, idempotencyKey: string): Promise<void> { await this.graphql(`mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}`, { input: { issueId: itemId, body: `${body}\n\n<!-- sync:${idempotencyKey} -->` } }); }
  async applyDisposition(itemId: string, disposition: Disposition, reason?: string): Promise<void> {
    if (disposition === "rejected" && !reason?.trim()) throw new Error("rejection requires a recorded reason");
    await this.graphql(`mutation($id:String!,$stateId:String!){issueUpdate(id:$id,input:{stateId:$stateId}){success}}`, { id: itemId, stateId: this.config.dispositionStateIds[disposition] });
    await this.addComment(itemId, `Review disposition: ${disposition}${reason ? ` — ${reason.trim()}` : ""}`, `disposition:${disposition}`);
  }
  async parseAndVerifyWebhook(body: Uint8Array, headers: Readonly<Record<string, string>>): Promise<TrackerWebhook> {
    requireWebhookBody(body);
    if (!verifyHmacSha256(body, headers["linear-signature"], this.config.webhookSecret, "")) throw new Error("invalid Linear webhook signature");
    const raw = JSON.parse(new TextDecoder().decode(body)) as { type?: string; data?: { id?: string; body?: string }; webhookTimestamp?: number };
    requireFreshTimestamp(raw.webhookTimestamp ?? headers["linear-timestamp"], this.config.now());
    return { deliveryId: requireDeliveryId(headers["linear-delivery"]), event: raw.type ?? headers["linear-event"] ?? "unknown", workItemId: raw.data?.id, commentBody: raw.data?.body, raw };
  }
  async graphql<T>(query: string, variables: unknown): Promise<T> {
    const response = await this.transport.request<{ data?: T; errors?: unknown }>({ method: "POST", url: this.config.endpoint, headers: { authorization: this.config.token }, body: { query, variables } });
    if (!response.data || response.errors) throw new Error("Linear GraphQL operation failed");
    return response.data;
  }
}
