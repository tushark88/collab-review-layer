# Collaborative Prototype Review

This context describes durable feedback on live or archived prototype revisions and its selective handoff into external work trackers.

## Language

**Prototype**:
A reviewable product surface whose revisions may be live, archived, or both.
_Avoid_: Site, app, target

**Revision**:
An immutable identity for one state of a Prototype, optionally backed by a deploy, commit, or archived artifact.
_Avoid_: Version, build

**Review**:
A bounded collaborative evaluation of one Prototype across one or more Revisions, Variants, and Viewports.
_Avoid_: Session, project

**Viewport**:
A named presentation geometry and pixel ratio used to observe a Revision.
_Avoid_: Device, screen size

**Variant**:
A declared product-state alternative within a Revision.
_Avoid_: Option, mode

**Route**:
An origin-relative navigation location within a Revision at which review evidence is observed.
_Avoid_: URL, page

**Interaction Mode**:
The shell's current interpretation of reviewer input as pointer exploration or comment placement. It is transient presentation state, not a Variant or Disposition.
_Avoid_: Variant, status

**Thread**:
A durable discussion anchored to explicit Review Context. Its first Message author owns Anchor Replacement; its lifecycle is independent of a linked Work Item.
_Avoid_: Pin, issue, comment

**Message**:
An authored entry in a Thread. The first Message is not the Thread itself.
_Avoid_: Reply when referring to the first entry

**Anchor**:
A versioned bundle of element-local, document-space, semantic, textual, and immutable Review Context evidence locating a Thread in a Revision. Only a current, available Anchor may produce a visible pin.
_Avoid_: Coordinates, selector

**Location Availability**:
An explicit statement that a Thread's Anchor is either available for placement or unavailable. Unavailable location is durable state, not permission to approximate a pin.
_Avoid_: Missing coordinates, hidden pin

**Anchor Recovery State**:
The durable explanation of whether an unavailable Anchor requires replacement because it is legacy or orphaned.
_Avoid_: Error, fallback

**Anchor Replacement**:
An authorized re-placement of an existing Thread that preserves its identity, discussion, lifecycle state, and prior event history.
_Avoid_: New Thread, re-pin

**Anchor Orphan Report**:
An authorized durable observation that a current Anchor is no longer attachable. It removes placement data from the read model while retaining immutable Anchor Context until replacement.
_Avoid_: Hidden pin, failed request

**Capture**:
Immutable evidence observed at a specific Revision, Viewport, Variant, route, and time, identified by a content digest.
_Avoid_: Screenshot when the evidence may have another medium

**Disposition**:
The recorded decision that a Thread is accepted, rejected, or implemented and verified.
_Avoid_: Status

**Work Container**:
A provider-owned collection of Work Items, such as a Linear project or GitHub repository/project.
_Avoid_: Board, tracker project

**Work Item**:
An external actionable record linked to a Thread; the tracker owns assignment, priority, and workflow state.
_Avoid_: Issue when speaking provider-neutrally

**Tracker Projection**:
A synchronized Work Container and its Work Items derived from shell-owned review history. It is never the canonical record of Anchors, Captures, or Thread history.
_Avoid_: Integration, source of truth

**External Link**:
The durable association between one Thread and one provider-owned Work Item, including provider identity and synchronization position.
_Avoid_: URL, attachment
