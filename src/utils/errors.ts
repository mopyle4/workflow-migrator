/**
 * Custom error hierarchy for structured error handling.
 *
 * Design Pattern: Error hierarchy with error codes for programmatic handling
 */

export enum ErrorCode {
  INVALID_INPUT = 'INVALID_INPUT',
  PARSE_ERROR = 'PARSE_ERROR',
  UNSUPPORTED_PLATFORM = 'UNSUPPORTED_PLATFORM',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  CONVERSION_ERROR = 'CONVERSION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}

export class WorkflowMigratorError extends Error {
  public readonly code: ErrorCode;
  public readonly context?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'WorkflowMigratorError';
    this.code = code;
    this.context = context;

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, WorkflowMigratorError);
    }
  }
}

export class ParseError extends WorkflowMigratorError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(ErrorCode.PARSE_ERROR, message, context);
    this.name = 'ParseError';
  }
}

export class ValidationError extends WorkflowMigratorError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_ERROR, message, context);
    this.name = 'ValidationError';
  }
}

export class ConversionError extends WorkflowMigratorError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(ErrorCode.CONVERSION_ERROR, message, context);
    this.name = 'ConversionError';
  }
}

/** Map error codes to CLI exit codes */
export function getExitCode(error: WorkflowMigratorError): number {
  switch (error.code) {
    case ErrorCode.FILE_NOT_FOUND:
    case ErrorCode.INVALID_INPUT:
    case ErrorCode.UNSUPPORTED_PLATFORM:
      return 1; // User input error
    case ErrorCode.PARSE_ERROR:
    case ErrorCode.VALIDATION_ERROR:
      return 2; // Invalid workflow
    case ErrorCode.CONVERSION_ERROR:
      return 3; // Conversion failure
    case ErrorCode.FILE_TOO_LARGE:
      return 4; // Resource limit
    default:
      return 99; // Unknown
  }
}
