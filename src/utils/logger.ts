/**
 * Structured logger with severity levels.
 * Outputs to stderr so stdout remains clean for piped ASL output.
 *
 * Design Pattern: Singleton with configurable verbosity
 */

export enum LogLevel {
  SILENT = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
}

class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (this.level >= LogLevel.ERROR) {
      this.emit(LogLevel.ERROR, message, context);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.level >= LogLevel.WARN) {
      this.emit(LogLevel.WARN, message, context);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.level >= LogLevel.INFO) {
      this.emit(LogLevel.INFO, message, context);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.level >= LogLevel.DEBUG) {
      this.emit(LogLevel.DEBUG, message, context);
    }
  }

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const prefix = this.getPrefix(level);
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';

    // Output to stderr to keep stdout clean for piped output
    process.stderr.write(`${prefix} ${message}${contextStr}\n`);
  }

  private getPrefix(level: LogLevel): string {
    switch (level) {
      case LogLevel.ERROR:
        return '❌';
      case LogLevel.WARN:
        return '⚠️ ';
      case LogLevel.INFO:
        return '📋';
      case LogLevel.DEBUG:
        return '🔍';
      default:
        return '  ';
    }
  }
}

/** Singleton logger instance */
export const logger = new Logger();
