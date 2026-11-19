-- Keep activation provenance separate from extraction, upload and original publication.
ALTER TABLE ci_sources ADD COLUMN active_at INTEGER;
ALTER TABLE ci_sources ADD COLUMN active_actor TEXT;
UPDATE ci_sources SET
 active_at=(SELECT published FROM ci_imports WHERE id=ci_sources.active_version_id),
 active_actor=(SELECT actor FROM ci_imports WHERE id=ci_sources.active_version_id)
WHERE active_version_id IS NOT NULL;
