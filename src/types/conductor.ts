/**
 * Netflix Conductor workflow definition types
 * Based on Conductor JSON DSL schema
 */

export interface ConductorWorkflow {
  name: string;
  description?: string;
  version: number;
  tasks: ConductorTask[];
  inputParameters?: string[];
  outputParameters?: Record<string, string>;
  schemaVersion?: number;
  restartable?: boolean;
  ownerEmail?: string;
  timeoutSeconds?: number;
}

export interface ConductorTask {
  name: string;
  taskReferenceName: string;
  type: ConductorTaskType;
  inputParameters?: Record<string, any>;
  timeoutSeconds?: number;
  retryCount?: number;
  // DECISION task fields
  caseValueParam?: string;
  decisionCases?: Record<string, ConductorTask[]>;
  defaultCase?: ConductorTask[];
  // FORK_JOIN fields
  forkTasks?: ConductorTask[][];
  // JOIN fields
  joinOn?: string[];
  // SUB_WORKFLOW fields
  subWorkflowParam?: {
    name: string;
    version?: number;
  };
  // WAIT fields
  waitDuration?: string;
}

export type ConductorTaskType =
  | 'SIMPLE'
  | 'HTTP'
  | 'DECISION'
  | 'SWITCH'
  | 'FORK_JOIN'
  | 'JOIN'
  | 'SUB_WORKFLOW'
  | 'WAIT'
  | 'EVENT'
  | 'TERMINATE'
  | 'DO_WHILE'
  | 'SET_VARIABLE';
