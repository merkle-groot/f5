import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";

import path from "path";
import { mkdir } from "node:fs/promises";
import { CONFIG } from "../config/index.js";
import { RelayerDatabase } from "../types/db.types.js";
import {
  RequestStatus,
  WithdrawalPayload,
} from "../interfaces/relayer/request.js";

/**
 * Class representing an SQLite database for managing relayer requests.
 */
export class SqliteDatabase implements RelayerDatabase {
  /** Path to the SQLite database file. */
  readonly dbPath: string;

  /** Indicates whether the database has been initialized. */
  private _initialized: boolean = false;

  /** Database connection instance. */
  private db!: Database<sqlite3.Database, sqlite3.Statement>;

  /**
   * SQL statement for creating the requests table.
   *
   * `kind` is deliberately unconstrained (no CHECK): destination keys are config-driven,
   * so a new chain must not require a schema change.
   */
  private createTableRequest = `
CREATE TABLE IF NOT EXISTS requests (
    id UUID PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    request JSON,
    status TEXT CHECK(status IN ('BROADCASTED', 'FAILED', 'RECEIVED')) NOT NULL,
    txHash TEXT,
    error TEXT,
    kind TEXT NOT NULL DEFAULT 'l1-relay'
);
`;

  /**
   * Initializes the database with the given path.
   */
  constructor() {
    this.dbPath = path.resolve(CONFIG.sqlite_db_path);
  }

  /**
   * Getter for the database initialization status.
   *
   * @returns {boolean} - Whether the database is initialized.
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Initializes the database connection and creates necessary tables.
   *
   * @returns {Promise<void>} - A promise that resolves when initialization is complete.
   */
  async init(): Promise<void> {
    try {
      // SQLite creates the file, but not missing parent directories.
      await mkdir(path.dirname(this.dbPath), { recursive: true });
      this.db = await open({
        driver: sqlite3.Database,
        filename: this.dbPath,
      });
      await this.db.run(this.createTableRequest);
      await this.migrateKindColumn();
    } catch (error) {
      console.error("Unable to initialize SQLite database", error);
      throw error;
    }
    this._initialized = true;
    console.log("sqlite db initialized");
  }

  /**
   * Adds `kind` to a table created before destination writes existed.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so the column in
   * `createTableRequest` never lands on a live database. Existing rows are all L1
   * relays, which is exactly what the column default records.
   */
  private async migrateKindColumn(): Promise<void> {
    const columns = await this.db.all<{ name: string }[]>(`PRAGMA table_info(requests)`);
    if (columns.some((column) => column.name === "kind")) return;
    await this.db.run(`ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'l1-relay'`);
  }

  /**
   * Inserts a new request record into the database.
   *
   * @param {string} requestId - Unique ID for the request.
   * @param {number} timestamp - Timestamp of the request.
   * @param {WithdrawalPayload} req - The withdrawal payload associated with the request.
   * @returns {Promise<void>} - A promise that resolves when the request is stored.
   */
  async createNewRequest(
    requestId: string,
    timestamp: number,
    req: WithdrawalPayload,
  ): Promise<void> {
    return this.createRequest(requestId, timestamp, req, "l1-relay");
  }

  /**
   * Inserts a destination (L2 pool) write, so activations and L2 withdrawals get the
   * same audit trail L1 relays already have.
   *
   * @param {string} requestId - Unique ID for the request.
   * @param {number} timestamp - Timestamp of the request.
   * @param {unknown} payload - The request payload.
   * @param {string} kind - e.g. `op:activate`, `starknet:withdraw`.
   * @returns {Promise<void>} - A promise that resolves when the request is stored.
   */
  async createDestinationRequest(
    requestId: string,
    timestamp: number,
    payload: unknown,
    kind: string,
  ): Promise<void> {
    return this.createRequest(requestId, timestamp, payload, kind);
  }

  private async createRequest(
    requestId: string,
    timestamp: number,
    payload: unknown,
    kind: string,
  ): Promise<void> {
    const strigifiedPayload = JSON.stringify(payload, replacer);
    // Store initial request
    await this.db.run(
      `
      INSERT INTO requests (id, timestamp, request, status, kind)
      VALUES (?, ?, ?, ?, ?)
    `,
      [requestId, timestamp, strigifiedPayload, RequestStatus.RECEIVED, kind],
    );
  }

  /**
   * Updates a request record with broadcast status and transaction hash.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} txHash - The transaction hash.
   * @returns {Promise<void>} - A promise that resolves when the update is complete.
   */
  async updateBroadcastedRequest(
    requestId: string,
    txHash: string,
  ): Promise<void> {
    // Update database
    await this.db.run(
      `
      UPDATE requests
      SET status = ?, txHash = ?
      WHERE id = ?
    `,
      [RequestStatus.BROADCASTED, txHash, requestId],
    );
  }

  /**
   * Updates a request record with failed status and error message.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} errorMessage - The error message.
   * @returns {Promise<void>} - A promise that resolves when the update is complete.
   */
  async updateFailedRequest(
    requestId: string,
    errorMessage: string,
  ): Promise<void> {
    // Update database with error
    await this.db.run(
      `
      UPDATE requests
      SET status = ?, error = ?
      WHERE id = ?
    `,
      [RequestStatus.FAILED, errorMessage, requestId],
    );
  }
}

/**
 * Custom JSON replacer function to handle BigInt serialization.
 *
 * @param {string} key - The JSON key.
 * @param {unknown} value - The JSON value.
 * @returns {unknown} - The transformed value.
 */
function replacer(key: string, value: unknown) {
  return typeof value === "bigint" ? { $bigint: value.toString() } : value;
}
