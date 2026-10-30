-- Apply only to the TEST D1 after a backup; 0001 must already be applied.
-- Existing answers, IDs, hashes, receipts and revisions are preserved.
ALTER TABLE rsvp_responses ADD COLUMN archived_at TEXT DEFAULT NULL;
CREATE INDEX idx_rsvp_archived ON rsvp_responses(archived_at,id) WHERE archived_at IS NOT NULL;
CREATE TABLE rsvp_lifecycle_confirmations (
 token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('archive','restore','erase')),
 response_id TEXT NOT NULL, revision INTEGER NOT NULL, epoch TEXT NOT NULL,
 expires_at INTEGER NOT NULL, applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1))
);
CREATE INDEX idx_rsvp_lifecycle_expiry ON rsvp_lifecycle_confirmations(expires_at);
-- Replace only the old capacity triggers. No answer is rewritten.
DROP TRIGGER rsvp_parking_capacity_insert;
DROP TRIGGER rsvp_parking_capacity_update;
CREATE TRIGGER rsvp_parking_capacity_insert BEFORE INSERT ON rsvp_responses
WHEN NEW.archived_at IS NULL AND NEW.parking_status='approved'
BEGIN
 SELECT CASE WHEN NEW.attending!='Да, конечно!' OR COALESCE(NEW.parking_choice,'')!='yes'
 OR typeof(NEW.cars_requested)!='integer' OR NEW.cars_requested<1
 OR NEW.cars_requested + COALESCE((SELECT SUM(cars_requested) FROM rsvp_responses WHERE archived_at IS NULL AND parking_status='approved' AND id!=NEW.id),0)>8
 THEN RAISE(ABORT,'parking_capacity') END;
END;
CREATE TRIGGER rsvp_parking_capacity_update BEFORE UPDATE ON rsvp_responses
WHEN NEW.archived_at IS NULL AND NEW.parking_status='approved'
BEGIN
 SELECT CASE WHEN NEW.attending!='Да, конечно!' OR COALESCE(NEW.parking_choice,'')!='yes'
 OR typeof(NEW.cars_requested)!='integer' OR NEW.cars_requested<1
 OR NEW.cars_requested + COALESCE((SELECT SUM(cars_requested) FROM rsvp_responses WHERE archived_at IS NULL AND parking_status='approved' AND id!=NEW.id),0)>8
 THEN RAISE(ABORT,'parking_capacity') END;
END;
CREATE TRIGGER rsvp_restore_requires_review BEFORE UPDATE ON rsvp_responses
WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL
 AND NEW.parking_status IS NOT CASE WHEN NEW.attending='Да, конечно!' AND NEW.parking_choice='yes' THEN 'pending' ELSE 'not_requested' END
BEGIN
 SELECT RAISE(ABORT,'archive_restore_requires_review');
END;
