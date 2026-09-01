import type { AnchorContext, CurrentAnchor, ThreadAnchor, UnavailableAnchor } from "./domain.ts";
import {
  readAnchorCoordinate,
  readAnchorIdentifier,
  readAnchorMetadata,
  readAnchorSelector,
  readAnchorText,
} from "./anchor-constraints.ts";
import {
  readBridgeDevicePixelRatio,
  readBridgeOrigin,
  readBridgeRoute,
  readBridgeViewportDimension,
} from "./bridge-constraints.ts";

export const BRIDGE_PROTOCOL = "collab-review-layer.bridge" as const;
export const BRIDGE_WIRE_VERSION = 1 as const;
export const CURRENT_BRIDGE_PROTOCOL_VERSION = 2 as const;
export const BRIDGE_PROTOCOL_VERSIONS = Object.freeze([CURRENT_BRIDGE_PROTOCOL_VERSION] as const);
export const BRIDGE_CAPABILITIES = Object.freeze(["navigation", "focus", "viewport", "variant", "anchor"] as const);

export type BridgeProtocolVersion = (typeof BRIDGE_PROTOCOL_VERSIONS)[number];
export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];
export type BridgeRole = "host" | "prototype";
export type BridgeState = "idle" | "negotiating" | "active" | "rejected";
export type BridgeMessageMode = "request" | "report";

export interface BridgeNavigationMessage {
  type: "navigation";
  mode: BridgeMessageMode;
  route: string;
}

export interface BridgeFocusMessage {
  type: "focus";
  mode: BridgeMessageMode;
  focused: boolean;
  anchorId?: string;
}

export interface BridgeViewportMessage {
  type: "viewport";
  mode: BridgeMessageMode;
  viewportId: string;
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface BridgeVariantMessage {
  type: "variant";
  mode: BridgeMessageMode;
  variantId: string;
}

export type BridgeAnchorMessage =
  | { type: "anchor"; mode: "request"; threadId: string; anchorGeneration: number; anchor: CurrentAnchor }
  | { type: "anchor"; mode: "report"; threadId: string; anchorGeneration: number; anchor: CurrentAnchor; status: "attached" }
  | { type: "anchor"; mode: "report"; threadId: string; anchorGeneration: number; anchor: UnavailableAnchor; status: "orphaned" };

export type BridgeOperationalMessage =
  | BridgeNavigationMessage
  | BridgeFocusMessage
  | BridgeViewportMessage
  | BridgeVariantMessage
  | BridgeAnchorMessage;

export interface BridgeHelloMessage {
  type: "bridge.hello";
  supportedVersions: number[];
  capabilities: string[];
  maxMessageBytes: number;
}

export interface BridgeReadyMessage {
  type: "bridge.ready";
  protocolVersion: BridgeProtocolVersion;
  capabilities: BridgeCapability[];
  maxMessageBytes: number;
}

export interface BridgeRejectMessage {
  type: "bridge.reject";
  reason: "unsupported_version";
}

export type BridgeWireOperationalMessage = BridgeOperationalMessage & { protocolVersion: BridgeProtocolVersion };
export type BridgeWireMessage = BridgeHelloMessage | BridgeReadyMessage | BridgeRejectMessage | BridgeWireOperationalMessage;

export interface BridgeEnvelope {
  protocol: typeof BRIDGE_PROTOCOL;
  wireVersion: typeof BRIDGE_WIRE_VERSION;
  sessionId: string;
  nonce: string;
  sequence: number;
  message: BridgeWireMessage;
}

export interface BridgeSessionConfig {
  role: BridgeRole;
  sessionId: string;
  nonce: string;
  allowedOrigins: readonly string[];
  capabilities: readonly BridgeCapability[];
  maxMessageBytes?: number;
}

export interface BridgeSessionSnapshot {
  role: BridgeRole;
  state: BridgeState;
  peerOrigin?: string;
  protocolVersion?: BridgeProtocolVersion;
  capabilities: readonly BridgeCapability[];
  maxMessageBytes: number;
  nextInboundSequence: number;
  nextOutboundSequence: number;
}

export type BridgeReceiveResult =
  | { kind: "handshake"; reply?: BridgeEnvelope; snapshot: BridgeSessionSnapshot }
  | { kind: "message"; message: BridgeOperationalMessage; snapshot: BridgeSessionSnapshot };

export type BridgeProtocolErrorCode =
  | "invalid_config"
  | "invalid_origin"
  | "invalid_message"
  | "invalid_state"
  | "invalid_sequence"
  | "session_mismatch"
  | "unsupported_capability";

export class BridgeProtocolError extends Error {
  readonly code: BridgeProtocolErrorCode;

  constructor(code: BridgeProtocolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BridgeProtocolError";
    this.code = code;
  }
}

/**
 * Pure reference implementation of the cooperative host/prototype protocol.
 * A browser adapter owns postMessage wiring; this module owns validation,
 * negotiation, peer binding, sequencing, and capability enforcement.
 */
export class BridgeSession {
  readonly #role: BridgeRole;
  readonly #sessionId: string;
  readonly #nonce: string;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #availableCapabilities: ReadonlySet<BridgeCapability>;
  readonly #maxMessageBytes: number;
  #state: BridgeState = "idle";
  #peerOrigin?: string;
  #protocolVersion?: BridgeProtocolVersion;
  #negotiatedMaxMessageBytes?: number;
  #negotiatedCapabilities = new Set<BridgeCapability>();
  #nextInboundSequence = 0;
  #nextOutboundSequence = 0;

  constructor(config: BridgeSessionConfig) {
    if (config.role !== "host" && config.role !== "prototype") fail("invalid_config", "bridge role is invalid");
    this.#role = config.role;
    this.#sessionId = requireIdentifier(config.sessionId, "bridge session id");
    this.#nonce = requireNonce(config.nonce);
    if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0) fail("invalid_config", "bridge origin allowlist is required");
    const origins = config.allowedOrigins.map((origin) => normalizeOrigin(origin, "configured bridge origin"));
    if (new Set(origins).size !== origins.length) fail("invalid_config", "bridge origin allowlist contains duplicates");
    this.#allowedOrigins = new Set(origins);
    this.#availableCapabilities = new Set(parseCapabilities(config.capabilities, "configured bridge capabilities"));
    const maxMessageBytes = config.maxMessageBytes ?? 65_536;
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 1_048_576) {
      fail("invalid_config", "bridge message limit must be between 1 and 1048576 bytes");
    }
    this.#maxMessageBytes = maxMessageBytes;
  }

  initiate(): BridgeEnvelope {
    if (this.#role !== "host" || this.#state !== "idle") fail("invalid_state", "only an idle host can initiate a bridge session");
    const envelope = this.#envelope({
      type: "bridge.hello",
      supportedVersions: [...BRIDGE_PROTOCOL_VERSIONS],
      capabilities: [...this.#availableCapabilities],
      maxMessageBytes: this.#maxMessageBytes,
    });
    this.#state = "negotiating";
    return envelope;
  }

  receive(origin: string, value: unknown): BridgeReceiveResult {
    const normalizedOrigin = normalizeOrigin(origin, "received bridge origin");
    if (!this.#allowedOrigins.has(normalizedOrigin)) fail("invalid_origin", "bridge origin is not allowed");
    if (this.#peerOrigin !== undefined && this.#peerOrigin !== normalizedOrigin) fail("invalid_origin", "bridge session is already bound to another origin");
    const envelope = parseEnvelope(value, this.#negotiatedMaxMessageBytes ?? this.#maxMessageBytes);
    if (envelope.sessionId !== this.#sessionId || envelope.nonce !== this.#nonce) fail("session_mismatch", "bridge session identity does not match");
    if (envelope.sequence !== this.#nextInboundSequence) fail("invalid_sequence", "bridge message sequence is not contiguous");

    if (this.#state === "active") return this.#receiveOperational(normalizedOrigin, envelope);
    if (this.#role === "prototype" && this.#state === "idle") return this.#receiveHello(normalizedOrigin, envelope);
    if (this.#role === "host" && this.#state === "negotiating") return this.#receiveHandshakeResult(normalizedOrigin, envelope);
    fail("invalid_state", "bridge message is not valid in the current session state");
  }

  send(message: BridgeOperationalMessage): BridgeEnvelope {
    if (this.#state !== "active" || this.#protocolVersion === undefined) fail("invalid_state", "bridge handshake is not complete");
    const parsed = parseOperationalMessage(message, false);
    this.#requireCapability(parsed.type);
    return this.#envelope({ ...parsed, protocolVersion: this.#protocolVersion } as BridgeWireOperationalMessage);
  }

  snapshot(): BridgeSessionSnapshot {
    return {
      role: this.#role,
      state: this.#state,
      peerOrigin: this.#peerOrigin,
      protocolVersion: this.#protocolVersion,
      capabilities: [...this.#negotiatedCapabilities],
      maxMessageBytes: this.#negotiatedMaxMessageBytes ?? this.#maxMessageBytes,
      nextInboundSequence: this.#nextInboundSequence,
      nextOutboundSequence: this.#nextOutboundSequence,
    };
  }

  #receiveHello(origin: string, envelope: BridgeEnvelope): BridgeReceiveResult {
    if (envelope.message.type !== "bridge.hello") fail("invalid_state", "prototype expected a bridge hello");
    assertBoundedJson(envelope, envelope.message.maxMessageBytes);
    const maxMessageBytes = Math.min(this.#maxMessageBytes, envelope.message.maxMessageBytes);
    if (!envelope.message.supportedVersions.includes(CURRENT_BRIDGE_PROTOCOL_VERSION)) {
      const reply = this.#envelope({ type: "bridge.reject", reason: "unsupported_version" }, maxMessageBytes);
      this.#peerOrigin = origin;
      this.#nextInboundSequence += 1;
      this.#state = "rejected";
      return { kind: "handshake", reply, snapshot: this.snapshot() };
    }
    const capabilities = envelope.message.capabilities.filter(
      (capability): capability is BridgeCapability => isBridgeCapability(capability) && this.#availableCapabilities.has(capability),
    );
    const reply = this.#envelope({ type: "bridge.ready", protocolVersion: CURRENT_BRIDGE_PROTOCOL_VERSION, capabilities, maxMessageBytes }, maxMessageBytes);
    this.#peerOrigin = origin;
    this.#nextInboundSequence += 1;
    this.#protocolVersion = CURRENT_BRIDGE_PROTOCOL_VERSION;
    this.#negotiatedCapabilities = new Set(capabilities);
    this.#negotiatedMaxMessageBytes = maxMessageBytes;
    this.#state = "active";
    return { kind: "handshake", reply, snapshot: this.snapshot() };
  }

  #receiveHandshakeResult(origin: string, envelope: BridgeEnvelope): BridgeReceiveResult {
    if (envelope.message.type === "bridge.reject") {
      this.#peerOrigin = origin;
      this.#nextInboundSequence += 1;
      this.#state = "rejected";
      return { kind: "handshake", snapshot: this.snapshot() };
    }
    if (envelope.message.type !== "bridge.ready") fail("invalid_state", "host expected a bridge ready or reject message");
    const capabilities = parseCapabilities(envelope.message.capabilities, "negotiated bridge capabilities");
    if (
      envelope.message.protocolVersion !== CURRENT_BRIDGE_PROTOCOL_VERSION
      || capabilities.some((capability) => !this.#availableCapabilities.has(capability))
      || envelope.message.maxMessageBytes > this.#maxMessageBytes
    ) {
      fail("invalid_message", "bridge negotiation selected unsupported capabilities, version, or message limit");
    }
    assertBoundedJson(envelope, envelope.message.maxMessageBytes);
    this.#peerOrigin = origin;
    this.#protocolVersion = envelope.message.protocolVersion;
    this.#negotiatedCapabilities = new Set(capabilities);
    this.#negotiatedMaxMessageBytes = envelope.message.maxMessageBytes;
    this.#nextInboundSequence += 1;
    this.#state = "active";
    return { kind: "handshake", snapshot: this.snapshot() };
  }

  #receiveOperational(origin: string, envelope: BridgeEnvelope): BridgeReceiveResult {
    if (this.#peerOrigin !== origin || this.#protocolVersion === undefined) fail("invalid_origin", "bridge peer origin is not bound");
    const message = parseOperationalMessage(envelope.message, true);
    if (message.protocolVersion !== this.#protocolVersion) fail("invalid_message", "bridge protocol version changed during the session");
    const { protocolVersion: _protocolVersion, ...operational } = message;
    this.#requireCapability(operational.type);
    this.#nextInboundSequence += 1;
    return { kind: "message", message: structuredClone(operational) as BridgeOperationalMessage, snapshot: this.snapshot() };
  }

  #requireCapability(capability: BridgeCapability): void {
    if (!this.#negotiatedCapabilities.has(capability)) fail("unsupported_capability", `bridge capability is not negotiated: ${capability}`);
  }

  #envelope(message: BridgeWireMessage, maxMessageBytes = this.#negotiatedMaxMessageBytes ?? this.#maxMessageBytes): BridgeEnvelope {
    const envelope: BridgeEnvelope = {
      protocol: BRIDGE_PROTOCOL,
      wireVersion: BRIDGE_WIRE_VERSION,
      sessionId: this.#sessionId,
      nonce: this.#nonce,
      sequence: this.#nextOutboundSequence,
      message: structuredClone(message),
    };
    assertBoundedJson(envelope, maxMessageBytes);
    this.#nextOutboundSequence += 1;
    return envelope;
  }
}

function parseEnvelope(value: unknown, maxMessageBytes: number): BridgeEnvelope {
  assertBoundedJson(value, maxMessageBytes);
  const object = requireExactKeys(
    requireObject(value, "bridge envelope"),
    ["protocol", "wireVersion", "sessionId", "nonce", "sequence", "message"],
    [],
    "bridge envelope",
  );
  if (object.protocol !== BRIDGE_PROTOCOL || object.wireVersion !== BRIDGE_WIRE_VERSION) fail("invalid_message", "bridge envelope protocol is invalid");
  const sequence = requireSafeInteger(object.sequence, "bridge sequence", 0, Number.MAX_SAFE_INTEGER);
  return {
    protocol: BRIDGE_PROTOCOL,
    wireVersion: BRIDGE_WIRE_VERSION,
    sessionId: requireIdentifier(object.sessionId, "bridge session id"),
    nonce: requireNonce(object.nonce),
    sequence,
    message: parseWireMessage(object.message),
  };
}

function parseWireMessage(value: unknown): BridgeWireMessage {
  const candidate = requireObject(value, "bridge message");
  const type = requireString(requireOwnField(candidate, "type", "bridge message"), "bridge message type", 64);
  if (type === "bridge.hello") {
    const object = requireExactKeys(candidate, ["type", "supportedVersions", "capabilities", "maxMessageBytes"], [], "bridge hello");
    const versions = requireArray(object.supportedVersions, "bridge supported versions").map((version) => requireSafeInteger(version, "bridge protocol version", 1, 65_535));
    if (versions.length === 0 || new Set(versions).size !== versions.length) fail("invalid_message", "bridge supported versions are empty or duplicated");
    return {
      type,
      supportedVersions: versions,
      capabilities: parseCapabilityNames(object.capabilities, "bridge requested capabilities"),
      maxMessageBytes: requireSafeInteger(object.maxMessageBytes, "bridge requested message limit", 1, 1_048_576),
    };
  }
  if (type === "bridge.ready") {
    const object = requireExactKeys(candidate, ["type", "protocolVersion", "capabilities", "maxMessageBytes"], [], "bridge ready");
    return {
      type,
      protocolVersion: requireSafeInteger(
        object.protocolVersion,
        "bridge protocol version",
        CURRENT_BRIDGE_PROTOCOL_VERSION,
        CURRENT_BRIDGE_PROTOCOL_VERSION,
      ) as BridgeProtocolVersion,
      capabilities: parseCapabilities(object.capabilities, "bridge negotiated capabilities"),
      maxMessageBytes: requireSafeInteger(object.maxMessageBytes, "bridge negotiated message limit", 1, 1_048_576),
    };
  }
  if (type === "bridge.reject") {
    const object = requireExactKeys(candidate, ["type", "reason"], [], "bridge reject");
    if (object.reason !== "unsupported_version") fail("invalid_message", "bridge rejection reason is invalid");
    return { type, reason: object.reason };
  }
  return parseOperationalMessage(candidate, true);
}

function parseOperationalMessage(value: unknown, wire: false): BridgeOperationalMessage;
function parseOperationalMessage(value: unknown, wire: true): BridgeWireOperationalMessage;
function parseOperationalMessage(value: unknown, wire: boolean): BridgeOperationalMessage | BridgeWireOperationalMessage {
  const candidate = requireObject(value, "bridge operational message");
  const type = requireCapability(requireOwnField(candidate, "type", "bridge operational message"), "bridge operational message type");
  const mode = requireMode(requireOwnField(candidate, "mode", "bridge operational message"));
  const protocolVersion = wire
    ? requireSafeInteger(
      requireOwnField(candidate, "protocolVersion", "bridge operational message"),
      "bridge protocol version",
      CURRENT_BRIDGE_PROTOCOL_VERSION,
      CURRENT_BRIDGE_PROTOCOL_VERSION,
    ) as BridgeProtocolVersion
    : undefined;
  const versionKey = wire ? ["protocolVersion"] : [];
  if (type === "navigation") {
    const object = requireExactKeys(candidate, ["type", "mode", "route", ...versionKey], [], "bridge navigation message");
    return withProtocolVersion({ type, mode, route: requireRoute(object.route) }, protocolVersion);
  }
  if (type === "focus") {
    const object = requireExactKeys(candidate, ["type", "mode", "focused", ...versionKey], ["anchorId"], "bridge focus message");
    if (typeof object.focused !== "boolean") fail("invalid_message", "bridge focus state must be boolean");
    const message: BridgeFocusMessage = { type, mode, focused: object.focused };
    if (object.anchorId !== undefined) message.anchorId = requireIdentifier(object.anchorId, "bridge focus anchor id");
    return withProtocolVersion(message, protocolVersion);
  }
  if (type === "viewport") {
    const object = requireExactKeys(
      candidate,
      ["type", "mode", "viewportId", "width", "height", "devicePixelRatio", ...versionKey],
      [],
      "bridge viewport message",
    );
    return withProtocolVersion({
      type,
      mode,
      viewportId: requireIdentifier(object.viewportId, "bridge viewport id"),
      width: requireViewportDimension(object.width, "bridge viewport width"),
      height: requireViewportDimension(object.height, "bridge viewport height"),
      devicePixelRatio: requireDevicePixelRatio(object.devicePixelRatio, "bridge device pixel ratio"),
    }, protocolVersion);
  }
  if (type === "variant") {
    const object = requireExactKeys(candidate, ["type", "mode", "variantId", ...versionKey], [], "bridge variant message");
    return withProtocolVersion({ type, mode, variantId: requireIdentifier(object.variantId, "bridge variant id") }, protocolVersion);
  }
  const object = requireExactKeys(
    candidate,
    mode === "request"
      ? ["type", "mode", "threadId", "anchorGeneration", "anchor", ...versionKey]
      : ["type", "mode", "threadId", "anchorGeneration", "anchor", "status", ...versionKey],
    [],
    "bridge anchor message",
  );
  const threadId = requireIdentifier(object.threadId, "bridge anchor thread id");
  const anchorGeneration = requireSafeInteger(object.anchorGeneration, "bridge anchor generation", 1, Number.MAX_SAFE_INTEGER);
  const anchor = parseAnchor(object.anchor);
  if (mode === "request") {
    if (anchor.locationAvailability !== "available") fail("invalid_message", "only an available current anchor can be requested for placement");
    return withProtocolVersion({ type, mode, threadId, anchorGeneration, anchor }, protocolVersion);
  }
  if (object.status !== "attached" && object.status !== "orphaned") fail("invalid_message", "bridge anchor report status is invalid");
  if (anchor.locationAvailability === "unavailable") {
    if (object.status !== "orphaned") fail("invalid_message", "an unavailable anchor can only report an orphaned location");
    return withProtocolVersion({ type, mode, threadId, anchorGeneration, anchor, status: "orphaned" }, protocolVersion);
  }
  if (object.status !== "attached") fail("invalid_message", "an orphaned report requires an unavailable anchor");
  return withProtocolVersion({ type, mode, threadId, anchorGeneration, anchor, status: "attached" }, protocolVersion);
}

function withProtocolVersion<T extends BridgeOperationalMessage>(message: T, protocolVersion: BridgeProtocolVersion | undefined): T | (T & { protocolVersion: BridgeProtocolVersion }) {
  return protocolVersion === undefined ? message : { ...message, protocolVersion };
}

function parseAnchor(value: unknown): ThreadAnchor {
  const candidate = requireObject(value, "bridge anchor");
  const schemaVersion = requireOwnField(candidate, "schemaVersion", "bridge anchor");
  if (schemaVersion === 2 && candidate.locationAvailability === "available") return parseCurrentAnchor(candidate);
  return parseUnavailableAnchor(candidate);
}

function parseUnavailableAnchor(candidate: Record<string, unknown>): UnavailableAnchor {
  if (candidate.schemaVersion === 1) {
    const object = requireExactKeys(
      candidate,
      ["schemaVersion", "locationAvailability", "recoveryState"],
      [],
      "legacy unavailable bridge anchor",
    );
    if (object.locationAvailability !== "unavailable" || object.recoveryState !== "legacy_replacement_required") {
      fail("invalid_message", "legacy unavailable bridge anchor state is invalid");
    }
    return { schemaVersion: 1, locationAvailability: "unavailable", recoveryState: "legacy_replacement_required" };
  }
  if (candidate.schemaVersion === 2) {
    const object = requireExactKeys(
      candidate,
      ["schemaVersion", "locationAvailability", "recoveryState", "context"],
      [],
      "orphaned bridge anchor",
    );
    if (object.locationAvailability !== "unavailable" || object.recoveryState !== "orphaned_replacement_required") {
      fail("invalid_message", "orphaned bridge anchor state is invalid");
    }
    return {
      schemaVersion: 2,
      locationAvailability: "unavailable",
      recoveryState: "orphaned_replacement_required",
      context: parseAnchorContext(object.context, "orphaned bridge anchor context"),
    };
  }
  fail("invalid_message", "unavailable bridge anchor version or recovery state is invalid");
}

function parseCurrentAnchor(candidate: Record<string, unknown>): CurrentAnchor {
  const object = requireExactKeys(
    candidate,
    ["schemaVersion", "locationAvailability", "recoveryState", "context", "element", "document"],
    ["semantic", "text"],
    "current bridge anchor",
  );
  if (object.schemaVersion !== 2 || object.locationAvailability !== "available" || object.recoveryState !== "not_required") {
    fail("invalid_message", "current bridge anchor state is invalid");
  }
  const element = requireExactKeys(
    requireObject(object.element, "current bridge anchor element"),
    ["selector", "identity", "offset"],
    [],
    "current bridge anchor element",
  );
  const offset = parseAnchorPosition(element.offset, "current bridge anchor element offset", 0);
  const document = requireExactKeys(
    requireObject(object.document, "current bridge anchor document"),
    ["x", "y", "width", "height"],
    [],
    "current bridge anchor document",
  );
  const anchor: CurrentAnchor = {
    schemaVersion: 2,
    locationAvailability: "available",
    recoveryState: "not_required",
    context: parseAnchorContext(object.context, "current bridge anchor context"),
    element: {
      selector: requireAnchorSelector(element.selector, "current bridge anchor element selector"),
      identity: requireIdentifier(element.identity, "current bridge anchor element identity"),
      offset,
    },
    document: {
      x: requireAnchorCoordinate(document.x, "current bridge anchor document x", 0),
      y: requireAnchorCoordinate(document.y, "current bridge anchor document y", 0),
      width: requireAnchorCoordinate(document.width, "current bridge anchor document width", 1),
      height: requireAnchorCoordinate(document.height, "current bridge anchor document height", 1),
    },
  };
  if (object.semantic !== undefined) anchor.semantic = parseAnchorSemantic(object.semantic);
  if (object.text !== undefined) anchor.text = parseAnchorText(object.text);
  return anchor;
}

function parseAnchorContext(value: unknown, label: string): AnchorContext {
  const context = requireExactKeys(
    requireObject(value, label),
    ["reviewId", "prototypeId", "revisionId", "viewportId", "variantId", "route", "deviceId", "surfaceId"],
    [],
    label,
  );
  return {
    reviewId: requireIdentifier(context.reviewId, `${label} review id`),
    prototypeId: requireIdentifier(context.prototypeId, `${label} prototype id`),
    revisionId: requireIdentifier(context.revisionId, `${label} revision id`),
    viewportId: requireIdentifier(context.viewportId, `${label} viewport id`),
    variantId: requireIdentifier(context.variantId, `${label} variant id`),
    route: requireRoute(context.route),
    deviceId: requireIdentifier(context.deviceId, `${label} device id`),
    surfaceId: requireIdentifier(context.surfaceId, `${label} surface id`),
  };
}

function parseAnchorPosition(value: unknown, label: string, minimum: number): { x: number; y: number } {
  const object = requireExactKeys(requireObject(value, label), ["x", "y"], [], label);
  return {
    x: requireAnchorCoordinate(object.x, `${label} x`, minimum),
    y: requireAnchorCoordinate(object.y, `${label} y`, minimum),
  };
}

function parseAnchorSemantic(value: unknown): NonNullable<CurrentAnchor["semantic"]> {
  const semantic = requireExactKeys(
    requireObject(value, "current bridge semantic anchor"),
    [],
    ["role", "accessibleName", "testId"],
    "current bridge semantic anchor",
  );
  const result: NonNullable<CurrentAnchor["semantic"]> = {};
  if (semantic.role !== undefined) result.role = requireAnchorMetadata(semantic.role, "current bridge anchor role", 256);
  if (semantic.accessibleName !== undefined) result.accessibleName = requireAnchorMetadata(semantic.accessibleName, "current bridge anchor accessible name", 2_048);
  if (semantic.testId !== undefined) result.testId = requireAnchorMetadata(semantic.testId, "current bridge anchor test id", 256);
  return result;
}

function parseAnchorText(value: unknown): NonNullable<CurrentAnchor["text"]> {
  const text = requireExactKeys(
    requireObject(value, "current bridge text anchor"),
    ["exact"],
    ["prefix", "suffix"],
    "current bridge text anchor",
  );
  const result: NonNullable<CurrentAnchor["text"]> = {
    exact: requireAnchorText(text.exact, "current bridge anchor exact text", 4_096),
  };
  if (text.prefix !== undefined) result.prefix = requireAnchorText(text.prefix, "current bridge anchor text prefix", 1_024);
  if (text.suffix !== undefined) result.suffix = requireAnchorText(text.suffix, "current bridge anchor text suffix", 1_024);
  return result;
}

function parseCapabilities(value: unknown, label: string): BridgeCapability[] {
  const values = requireArray(value, label).map((capability) => requireCapability(capability, label));
  if (new Set(values).size !== values.length) fail("invalid_message", `${label} contain duplicates`);
  return values;
}

function parseCapabilityNames(value: unknown, label: string): string[] {
  const values = requireArray(value, label).map((capability) => requireString(capability, label, 64));
  if (new Set(values).size !== values.length) fail("invalid_message", `${label} contain duplicates`);
  return values;
}

function isBridgeCapability(value: string): value is BridgeCapability {
  return BRIDGE_CAPABILITIES.includes(value as BridgeCapability);
}

function requireCapability(value: unknown, label: string): BridgeCapability {
  if (typeof value !== "string" || !BRIDGE_CAPABILITIES.includes(value as BridgeCapability)) fail("invalid_message", `${label} are invalid`);
  return value as BridgeCapability;
}

function requireMode(value: unknown): BridgeMessageMode {
  if (value !== "request" && value !== "report") fail("invalid_message", "bridge message mode is invalid");
  return value;
}

function requireRoute(value: unknown): string {
  const result = readBridgeRoute(value);
  if (result.ok) return result.value;
  if (result.problem === "invalid") fail("invalid_message", "bridge route is invalid");
  if (result.problem === "origin_relative") fail("invalid_message", "bridge route must be an origin-relative path");
  fail("invalid_message", "bridge route must not change origin");
}

function requireViewportDimension(value: unknown, label: string): number {
  const result = readBridgeViewportDimension(value);
  if (!result.ok) fail("invalid_message", `${label} is invalid`);
  return result.value;
}

function requireDevicePixelRatio(value: unknown, label: string): number {
  const result = readBridgeDevicePixelRatio(value);
  if (!result.ok) fail("invalid_message", `${label} is invalid`);
  return result.value;
}

function requireIdentifier(value: unknown, label: string): string {
  const result = readAnchorIdentifier(value);
  if (!result.ok) fail("invalid_message", `${label} is invalid`);
  return result.value;
}

function requireNonce(value: unknown): string {
  const nonce = requireString(value, "bridge nonce", 256);
  if (nonce.length < 16) fail("invalid_message", "bridge nonce must contain at least 16 characters");
  return nonce;
}

function requireString(value: unknown, label: string, maxLength: number, allowEmptyOrWhitespace = false): string {
  if (typeof value !== "string" || value.length > maxLength || value.includes("\u0000") || value.includes("\r") || value.includes("\n")) {
    fail("invalid_message", `${label} is invalid`);
  }
  if (!allowEmptyOrWhitespace && !value.trim()) fail("invalid_message", `${label} is invalid`);
  return value;
}

function requireAnchorText(value: unknown, label: string, maxLength: number): string {
  const result = readAnchorText(value, maxLength);
  if (!result.ok) fail("invalid_message", `${label} is invalid`);
  return result.value;
}

function requireAnchorSelector(value: unknown, label: string): string {
  const result = readAnchorSelector(value);
  if (!result.ok) fail("invalid_message", `${label} is invalid`);
  return result.value;
}

function requireAnchorMetadata(value: unknown, label: string, maximumLength: number): string {
  const result = readAnchorMetadata(value, maximumLength);
  if (!result.ok) fail("invalid_message", `${label} is invalid`);
  return result.value;
}

function requireAnchorCoordinate(value: unknown, label: string, minimum: number): number {
  const result = readAnchorCoordinate(value, minimum);
  if (!result.ok) fail("invalid_message", `${label} is invalid`);
  return result.value;
}

function assertBoundedJson(value: unknown, maximumBytes: number): void {
  let bytes = 0;
  const active = new WeakSet<object>();
  const add = (count: number): void => {
    bytes += count;
    if (bytes > maximumBytes) fail("invalid_message", "bridge message exceeds the configured limit");
  };
  const visit = (current: unknown, depth: number): void => {
    if (depth > 64) fail("invalid_message", "bridge message nesting is too deep");
    if (current === null) {
      add(4);
      return;
    }
    if (typeof current === "string") {
      addJsonStringBytes(current, add);
      return;
    }
    if (typeof current === "boolean") {
      add(current ? 4 : 5);
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("invalid_message", "bridge message numbers must be finite");
      add(JSON.stringify(current).length);
      return;
    }
    if (typeof current !== "object") fail("invalid_message", "bridge message must be JSON-compatible");
    if (active.has(current)) fail("invalid_message", "bridge message must not contain cycles");
    active.add(current);
    if (Array.isArray(current)) {
      add(2);
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor) fail("invalid_message", "bridge message arrays must not be sparse");
        if (!descriptor.enumerable || !("value" in descriptor)) fail("invalid_message", "bridge message arrays must contain enumerable data properties");
        if (index > 0) add(1);
        visit(descriptor.value, depth + 1);
      }
      active.delete(current);
      return;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) fail("invalid_message", "bridge message objects must be plain records");
    add(2);
    let entries = 0;
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor)) fail("invalid_message", "bridge message accessors are not allowed");
      if (entries > 0) add(1);
      addJsonStringBytes(key, add);
      add(1);
      visit(descriptor.value, depth + 1);
      entries += 1;
    }
    active.delete(current);
  };
  visit(value, 0);
}

function addJsonStringBytes(value: string, add: (count: number) => void): void {
  add(2);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      add(2);
    } else if (code <= 0x1f) {
      add(6);
    } else if (code <= 0x7f) {
      add(1);
    } else if (code <= 0x7ff) {
      add(2);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < value.length ? value.charCodeAt(index + 1) : undefined;
      if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
        add(4);
        index += 1;
      } else {
        add(6);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      add(6);
    } else {
      add(3);
    }
  }
}

function requireSafeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail("invalid_message", `${label} is invalid`);
  return value as number;
}

function requireFiniteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail("invalid_message", `${label} is invalid`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid_message", `${label} are invalid`);
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("invalid_message", `${label} must contain enumerable data properties`);
    values.push(descriptor.value);
  }
  return values;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_message", `${label} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("invalid_message", `${label} must be a plain record`);
  return value as Record<string, unknown>;
}

function requireExactKeys(
  object: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  const allowedKeys = new Set([...required, ...optional]);
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    if (!allowedKeys.has(key)) fail("invalid_message", `${label} contains unknown fields`);
    fields[key] = requireOwnField(object, key, label);
  }
  for (const key of required) fields[key] = requireOwnField(object, key, label);
  for (const key of optional) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined) fields[key] = requireOwnField(object, key, label);
  }
  return fields;
}

function requireOwnField(object: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    fail("invalid_message", `${label} field ${key} must be an enumerable own data property`);
  }
  return descriptor.value;
}

function normalizeOrigin(value: unknown, label: string): string {
  const result = readBridgeOrigin(value);
  if (result.ok) return result.value;
  if (result.problem === "https_required") fail("invalid_origin", `${label} must use HTTPS outside loopback development`);
  if (result.problem === "origin_only") fail("invalid_origin", `${label} must contain only an origin`);
  fail("invalid_origin", `${label} is invalid`);
}

function fail(code: BridgeProtocolErrorCode, message: string): never {
  throw new BridgeProtocolError(code, message);
}
