/**
 * Amazon States Language (ASL) types for Step Functions
 */

export interface ASLStateMachine {
  Comment?: string;
  StartAt: string;
  States: Record<string, ASLState>;
  TimeoutSeconds?: number;
}

export type ASLState =
  | TaskState
  | ChoiceState
  | ParallelState
  | WaitState
  | SucceedState
  | FailState
  | PassState;

export interface BaseState {
  Type: string;
  Comment?: string;
  Next?: string;
  End?: boolean;
}

export interface TaskState extends BaseState {
  Type: 'Task';
  Resource: string;
  Parameters?: Record<string, any>;
  ResultPath?: string;
  OutputPath?: string;
  InputPath?: string;
  TimeoutSeconds?: number;
  Retry?: RetryConfig[];
  Catch?: CatchConfig[];
}

export interface ChoiceState extends BaseState {
  Type: 'Choice';
  Choices: ChoiceRule[];
  Default?: string;
}

export interface ChoiceRule {
  Variable: string;
  StringEquals?: string;
  NumericEquals?: number;
  BooleanEquals?: boolean;
  Next: string;
}

export interface ParallelState extends BaseState {
  Type: 'Parallel';
  Branches: ASLStateMachine[];
  ResultPath?: string;
  Retry?: RetryConfig[];
  Catch?: CatchConfig[];
}

export interface WaitState extends BaseState {
  Type: 'Wait';
  Seconds?: number;
  Timestamp?: string;
  SecondsPath?: string;
  TimestampPath?: string;
}

export interface SucceedState extends BaseState {
  Type: 'Succeed';
}

export interface FailState extends BaseState {
  Type: 'Fail';
  Error?: string;
  Cause?: string;
}

export interface PassState extends BaseState {
  Type: 'Pass';
  Result?: any;
  ResultPath?: string;
}

export interface RetryConfig {
  ErrorEquals: string[];
  IntervalSeconds?: number;
  MaxAttempts?: number;
  BackoffRate?: number;
}

export interface CatchConfig {
  ErrorEquals: string[];
  Next: string;
  ResultPath?: string;
}
