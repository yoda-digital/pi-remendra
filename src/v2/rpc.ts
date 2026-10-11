/**
 * Calls that wait on the network and run outside the worker's one-at-a-time queue, so a
 * slow or cold embedding server never delays packet compilation or ingestion behind them.
 * Their database writes are synchronous transactions between awaits. Kept apart from
 * service.ts so the client (main thread) does not bundle the store.
 */
export const CONCURRENT_METHODS: readonly string[] = ["embed"];
