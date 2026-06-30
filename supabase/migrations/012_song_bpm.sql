-- Migration 012: bpm on songs (stated tempo — the conductor clock's static-BPM rung)
-- Additive and non-breaking: existing rows take NULL (no stated tempo). The library
-- is the authority for this field. It is the fallback rung of the chunk-5b clock
-- (docs/design-conductor-chunk5b-clock.md §5.5): with a stated bpm the MD can run a
-- click/metronome off it and dead-reckon the redline even before audio detection;
-- with NULL there is nothing to reckon from, so the clock stays on the manual rung.
-- Bounded to a sane musical range so a typo can't drive an absurd click.

alter table songs add column bpm integer check (bpm is null or (bpm >= 20 and bpm <= 400));
