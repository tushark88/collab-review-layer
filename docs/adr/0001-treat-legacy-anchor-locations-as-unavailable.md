# Treat legacy Anchor locations as unavailable

Ratio-only Anchor history remains immutable evidence, but it is not sufficient to place a trustworthy pin. The read model therefore projects legacy Anchors as location unavailable and replacement-required, while an authorized Anchor Replacement appends a current complete Anchor to the same Thread instead of mutating history or creating a new Thread; this prefers an honest recovery state over a plausible but wrong attachment.

Schema-version-2 Thread creation history without Anchor Generation is also pre-current-contract evidence. Replay validates its historical structure and immutable Review Context but projects the location as unavailable, and agent exports omit its placement fields, so later scalar hardening cannot block startup or silently re-trust pre-limit coordinates.
