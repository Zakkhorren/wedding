-- Apply once with Wrangler D1 migrations (transactional), AFTER a backup.
-- Matches the supplied live schema. No existing answer is deleted or rewritten.
-- Refuse an already inconsistent legacy parking allocation; do not silently fix data.
CREATE TABLE rsvp_v2_migration_guard (n INTEGER CHECK(n = 0), cars INTEGER CHECK(cars <= 8));
INSERT INTO rsvp_v2_migration_guard SELECT
 COALESCE(SUM(CASE WHEN parking_status='approved' AND
 (attending != 'Да, конечно!' OR COALESCE(parking_choice,'') != 'yes' OR
 typeof(cars_requested) != 'integer' OR cars_requested < 1) THEN 1 ELSE 0 END),0),
 COALESCE(SUM(CASE WHEN parking_status='approved' THEN cars_requested ELSE 0 END),0)
 FROM rsvp_responses;
DROP TABLE rsvp_v2_migration_guard;
ALTER TABLE rsvp_responses ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rsvp_responses ADD COLUMN last_request_id TEXT;
ALTER TABLE rsvp_responses ADD COLUMN last_write_seq INTEGER NOT NULL DEFAULT 0;
CREATE TABLE rsvp_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL,
 write_seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO rsvp_control(singleton,epoch) VALUES(1,lower(hex(randomblob(16))));
CREATE TABLE rsvp_requests (
 request_id TEXT PRIMARY KEY, response_id TEXT NOT NULL REFERENCES rsvp_responses(id) ON DELETE CASCADE,
 payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_rsvp_requests_response ON rsvp_requests(response_id);
CREATE TABLE rsvp_outbox (
 id TEXT PRIMARY KEY, response_id TEXT NOT NULL REFERENCES rsvp_responses(id) ON DELETE CASCADE,
 payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX idx_rsvp_outbox_due ON rsvp_outbox(state,next_attempt,lease_until);
CREATE TABLE telegram_updates (
 update_id INTEGER PRIMARY KEY, state TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE TABLE rsvp_admin_confirmations (
 token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('one','all')), response_id TEXT, revision INTEGER,
 cutoff_seq INTEGER NOT NULL, epoch TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX idx_rsvp_confirmation_expiry ON rsvp_admin_confirmations(expires_at);
-- Statement-level serialization plus these triggers protect EVERY writer, not just bot UI.
CREATE TRIGGER rsvp_parking_capacity_insert BEFORE INSERT ON rsvp_responses
WHEN NEW.parking_status='approved'
BEGIN
 SELECT CASE WHEN NEW.attending!='Да, конечно!' OR COALESCE(NEW.parking_choice,'')!='yes'
 OR typeof(NEW.cars_requested)!='integer' OR NEW.cars_requested<1
 OR NEW.cars_requested + COALESCE((SELECT SUM(cars_requested) FROM rsvp_responses WHERE parking_status='approved' AND id!=NEW.id),0)>8
 THEN RAISE(ABORT,'parking_capacity') END;
END;
CREATE TRIGGER rsvp_parking_capacity_update BEFORE UPDATE ON rsvp_responses
WHEN NEW.parking_status='approved'
BEGIN
 SELECT CASE WHEN NEW.attending!='Да, конечно!' OR COALESCE(NEW.parking_choice,'')!='yes'
 OR typeof(NEW.cars_requested)!='integer' OR NEW.cars_requested<1
 OR NEW.cars_requested + COALESCE((SELECT SUM(cars_requested) FROM rsvp_responses WHERE parking_status='approved' AND id!=NEW.id),0)>8
 THEN RAISE(ABORT,'parking_capacity') END;
END;
