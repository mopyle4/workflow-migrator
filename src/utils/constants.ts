/**
 * Application constants and configuration limits.
 * Centralizes magic numbers and configurable thresholds.
 */

/** Maximum input file size in bytes (10 MB) */
export const MAX_INPUT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Maximum number of tasks in a single workflow */
export const MAX_WORKFLOW_TASKS = 500;

/** Maximum nesting depth for recursive parameter mapping */
export const MAX_PARAMETER_DEPTH = 10;

/** Supported source platforms */
export const SUPPORTED_PLATFORMS = ['conductor', 'camunda'] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/** Default retry configuration for generated Task states */
export const DEFAULT_RETRY_CONFIG = {
  intervalSeconds: 2,
  maxAttempts: 3,
  backoffRate: 2.0,
};

/** ASL state name constraints */
export const MAX_STATE_NAME_LENGTH = 128;
