import pg from 'pg';

/**
 * Per-request access to Postgres through Hyperdrive. A Worker request must not
 * leave connections behind, so nothing here is process-wide: `query` shares one
 * lazily opened client for the request, `connect` opens a dedicated client for a
 * transaction (Hyperdrive pools the upstream connections), and `close` ends every
 * client the request opened. Keep the surface identical to the Node pool so the
 * services and their SQL are unchanged.
 */
export class DatabasePool {
  private shared: pg.Client | undefined;
  private readonly opened = new Set<pg.Client>();

  constructor(private readonly connectionString: string) {}

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    this.shared ??= await this.open();
    return this.shared.query<R>(text, values);
  }

  /** A dedicated client; `release()` ends it, mirroring `pg.PoolClient`. */
  async connect(): Promise<pg.PoolClient> {
    const client = await this.open();
    return Object.assign(client, { release: () => void this.end(client) });
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.opened].map((client) => this.end(client)));
  }

  private async open(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000 });
    this.opened.add(client);
    try {
      await client.connect();
    } catch (error) {
      this.opened.delete(client);
      throw error;
    }
    return client;
  }

  private async end(client: pg.Client): Promise<void> {
    if (!this.opened.delete(client)) return;
    await client.end().catch(() => undefined);
  }
}
