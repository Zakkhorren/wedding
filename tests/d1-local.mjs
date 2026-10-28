import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const legacySql = fs
  .readFileSync(path.join(root, "tests/fixtures/legacy-schema.sql"), "utf8")
  .replace(/^\uFEFF/, "");
export const migrationSql = fs
  .readFileSync(path.join(root, "worker/migrations/0001_rsvp_v2.sql"), "utf8")
  .replace(/^\uFEFF/, "");
export class D1Local {
  constructor(file = ":memory:") {
    this.sqlite = new DatabaseSync(file);
    this.sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.failNextBatch = false;
  }
  withSession() {
    return this;
  }
  prepare(sql) {
    const db = this;
    return {
      sql,
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async first(column) {
        const row = db.sqlite.prepare(sql).get(...this.values);
        return column ? row?.[column] : row || null;
      },
      async all() {
        return {
          success: true,
          results: db.sqlite.prepare(sql).all(...this.values),
        };
      },
      async run() {
        return db.execute(this);
      },
    };
  }
  execute(query) {
    const stmt = this.sqlite.prepare(query.sql);
    if (stmt.columns().length) {
      const results = stmt.all(...query.values);
      return {
        success: true,
        results,
        meta: {
          changes: Number(this.sqlite.prepare("SELECT changes() n").get().n),
        },
      };
    }
    const result = stmt.run(...query.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
  async batch(queries) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (this.failNextBatch) {
        this.failNextBatch = false;
        throw new Error("injected database outage");
      }
      const result = queries.map((query) => this.execute(query));
      this.sqlite.exec("COMMIT");
      return result;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  migrate() {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.exec(migrationSql);
      this.sqlite.exec("COMMIT");
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.sqlite.close();
  }
}
export function database() {
  const db = new D1Local();
  db.sqlite.exec(legacySql);
  db.migrate();
  return db;
}
