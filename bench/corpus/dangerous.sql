-- Ground truth: every statement here is genuinely dangerous on a large/hot table.
-- A tool scores a CATCH for flagging it, a MISS for staying silent.
CREATE INDEX idx_orders_email ON orders (email);
ALTER TABLE orders ADD COLUMN uid uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE orders ADD COLUMN tag_id bigint REFERENCES tags(id);
ALTER TABLE orders ALTER COLUMN total TYPE numeric(12,2);
ALTER TABLE orders ALTER COLUMN status SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT total_positive CHECK (total > 0);
ALTER TABLE orders ADD CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE orders ADD CONSTRAINT uq_email UNIQUE (email);
ALTER TABLE orders ADD COLUMN seq_no serial;
ALTER TABLE orders SET LOGGED;
REFRESH MATERIALIZED VIEW order_stats;
VACUUM FULL orders;
CLUSTER orders USING idx_orders_email;
DROP TABLE legacy_events;
TRUNCATE audit_log;
UPDATE orders SET migrated = true;
ALTER TABLE orders DROP COLUMN legacy_notes;
ALTER TABLE orders RENAME COLUMN state TO status2;
