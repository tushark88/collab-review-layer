export type Id = string;

export interface ReviewContext {
  reviewId: Id;
  prototypeId: Id;
  revisionId: Id;
  viewportId: Id;
  variantId: Id;
  route: string;
}

/** @deprecated Ratio-only history is readable for migration but cannot be placed or written. */
export interface LegacyAnchor {
  schemaVersion: 1;
  semantic?: { role?: string; accessibleName?: string; testId?: string };
  text?: { exact: string; prefix?: string; suffix?: string };
  geometry: { xRatio: number; yRatio: number };
  scroll: { xRatio: number; yRatio: number };
}

export const PREVIOUS_ANCHOR_SCHEMA_VERSION = 2 as const;
export const CURRENT_ANCHOR_SCHEMA_VERSION = 3 as const;

export interface AnchorContext extends ReviewContext {
  deviceId: Id;
  surfaceId: Id;
}

interface AvailableAnchorFields {
  locationAvailability: "available";
  recoveryState: "not_required";
  context: AnchorContext;
  element: {
    selector: string;
    identity: string;
    offset: { x: number; y: number };
  };
  document: { x: number; y: number; width: number; height: number };
  semantic?: { role?: string; accessibleName?: string; testId?: string };
  text?: { exact: string; prefix?: string; suffix?: string };
}

/** Schema 2 remains readable and placeable, but new writes must use schema 3. */
export interface PreviousAnchor extends AvailableAnchorFields {
  schemaVersion: typeof PREVIOUS_ANCHOR_SCHEMA_VERSION;
}

export interface CurrentAnchor extends AvailableAnchorFields {
  schemaVersion: typeof CURRENT_ANCHOR_SCHEMA_VERSION;
}

export type AvailableAnchor = PreviousAnchor | CurrentAnchor;

export interface LegacyUnavailableAnchor {
  schemaVersion: 1;
  locationAvailability: "unavailable";
  recoveryState: "legacy_replacement_required";
}

export interface LegacyCurrentUnavailableAnchor {
  schemaVersion: typeof PREVIOUS_ANCHOR_SCHEMA_VERSION | typeof CURRENT_ANCHOR_SCHEMA_VERSION;
  locationAvailability: "unavailable";
  recoveryState: "legacy_replacement_required";
  context: AnchorContext;
}

export interface OrphanedAnchor {
  schemaVersion: typeof PREVIOUS_ANCHOR_SCHEMA_VERSION | typeof CURRENT_ANCHOR_SCHEMA_VERSION;
  locationAvailability: "unavailable";
  recoveryState: "orphaned_replacement_required";
  context: AnchorContext;
}

export type UnavailableAnchor = LegacyUnavailableAnchor | LegacyCurrentUnavailableAnchor | OrphanedAnchor;

/** Admission input: new writes require CurrentAnchor; older schemas produce a typed conflict. */
export type Anchor = LegacyAnchor | PreviousAnchor | CurrentAnchor;
/** Read-model Anchor with explicit location availability. */
export type ThreadAnchor = AvailableAnchor | UnavailableAnchor;

export interface Capture {
  id: Id;
  digest: `sha256:${string}`;
  mediaType: string;
  createdAt: string;
}

export type Disposition = "accepted" | "rejected" | "implemented_verified";

export function requireDisposition(value: unknown): Disposition {
  if (value !== "accepted" && value !== "rejected" && value !== "implemented_verified") throw new Error("invalid disposition");
  return value;
}

export interface Message {
  id: Id;
  authorId: Id;
  body: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
}

export interface Thread {
  id: Id;
  context: ReviewContext;
  anchor: ThreadAnchor;
  /** Monotonic identity for the current Anchor placement on this Thread. */
  anchorGeneration: number;
  capture?: Capture;
  messages: Message[];
  resolvedAt?: string;
  disposition?: Disposition;
  dispositionReason?: string;
}

export interface DomainEvent<T = unknown> {
  id: Id;
  sequence: number;
  reviewId: Id;
  type: string;
  occurredAt: string;
  actorId: Id;
  payload: T;
}
