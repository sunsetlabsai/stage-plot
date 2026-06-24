-- Migration 010: artist on songs (song-level credit metadata)
-- Additive and non-breaking: existing rows take the '' default. The library is
-- the authority for this field; the roadmap save route reads songs.artist by
-- (owner_id, song_key) at render time to print it on the built chart, so the
-- printed credit always tracks the canonical song rather than a client-passed
-- (and forgeable) value.

alter table songs add column artist text not null default '';
