# Persist unavailable Anchor transitions

An authorized Anchor Orphan Report names the current Anchor Generation and appends explicit unavailable state with immutable Anchor Context and no placement coordinates, while a later owner-authorized Anchor Replacement advances that generation and restores a current location on the same Thread; superseded reports fail closed, preventing both delayed observations and restarts from resurrecting or invalidating the wrong placement.
