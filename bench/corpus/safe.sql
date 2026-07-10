-- Ground truth: every statement here is SAFE on modern Postgres (11+).
-- A tool scores a FALSE POSITIVE for flagging any of these as blocking danger.
CREATE INDEX CONCURRENTLY idx_c ON orders (email);
DROP INDEX CONCURRENTLY idx_old;
ALTER TABLE orders ADD COLUMN note text;
ALTER TABLE orders ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE orders ADD COLUMN qty int NOT NULL DEFAULT 0;
ALTER TABLE orders ADD CONSTRAINT chk CHECK (qty >= 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT chk;
ALTER TABLE orders ADD CONSTRAINT fk2 FOREIGN KEY (x) REFERENCES p(id) NOT VALID;
ALTER TABLE orders ADD CONSTRAINT uq2 UNIQUE USING INDEX uq2_idx;
ALTER TABLE orders ALTER COLUMN note SET DEFAULT 'none';
REFRESH MATERIALIZED VIEW CONCURRENTLY order_stats;
CREATE TABLE brand_new (id bigint PRIMARY KEY, v int);
CREATE INDEX idx_bn ON brand_new (v);
ALTER TABLE brand_new ADD CONSTRAINT bn_chk CHECK (v > 0);
