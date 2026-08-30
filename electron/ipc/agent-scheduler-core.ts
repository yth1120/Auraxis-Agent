/**
 * agent-scheduler-core.ts — compatibility facade.
 *
 * The scheduler implementation lives in agent-scheduler-class-impl.ts; types live
 * in agent-scheduler-types.ts. Keeping this entry point stable lets existing
 * callers and mocks continue importing from the historical path.
 */
export * from './agent-scheduler-class';
