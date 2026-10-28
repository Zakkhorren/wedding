CREATE TABLE rsvp_responses (
 id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, attending TEXT NOT NULL,
 additional_guests TEXT DEFAULT '', guest_count INTEGER,
 drinks_json TEXT NOT NULL DEFAULT '[]', custom_drink TEXT DEFAULT '',
 parking_choice TEXT DEFAULT '', cars_requested INTEGER DEFAULT 0,
 parking_status TEXT DEFAULT 'not_requested', message TEXT DEFAULT '',
 extra_answers_json TEXT NOT NULL DEFAULT '{}', edit_token_hash TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_rsvp_attending ON rsvp_responses(attending);
CREATE INDEX idx_rsvp_parking ON rsvp_responses(parking_status);
