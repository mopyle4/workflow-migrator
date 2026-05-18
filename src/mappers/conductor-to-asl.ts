import { ConductorWorkflow, ConductorTask } from '../types/conductor';
import {
  ASLStateMachine,
  ASLState,
  TaskState,
  ChoiceState,
  ParallelState,
  WaitState,
  SucceedState,
  FailState,
  RetryConfig,
} from '../types/asl';

export interface ConversionResult {
  stateMachine: ASLStateMachine;
  warnings: string[];
  metadata: {
    sourceTaskCount: number;
    generatedStateCount: number;
    unsupportedConstructs: string[];
  };
}

/**
 * Convert a Netflix Conductor workflow to AWS Step Functions ASL
 */
export function convertConductorToASL(workflow: ConductorWorkflow): ConversionResult {
  const warnings: string[] = [];
  const unsupportedConstructs: string[] = [];
  const states: Record<string, ASLState> = {};

  const tasks = workflow.tasks;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const isLast = i === tasks.length - 1;
    const nextStateName = isLast ? undefined : toStateName(tasks[i + 1].taskReferenceName);
    const stateName = toStateName(task.taskReferenceName);

    const result = convertTask(task, nextStateName, isLast, warnings, unsupportedConstructs);

    if (result.states) {
      // Some constructs (like DECISION) produce multiple states
      for (const [name, state] of Object.entries(result.states)) {
        states[name] = state;
      }
    } else if (result.state) {
      states[stateName] = result.state;
    }
  }

  // Add a terminal Succeed state
  const lastTask = tasks[tasks.length - 1];
  const lastStateName = toStateName(lastTask.taskReferenceName);
  const successStateName = 'WorkflowComplete';
  states[successStateName] = { Type: 'Succeed' } as SucceedState;

  // Update the last converted state to point to success
  const lastState = states[lastStateName];
  if (lastState && !('End' in lastState && lastState.End)) {
    if ('Next' in lastState) {
      // Already has Next, leave it
    } else {
      (lastState as any).Next = successStateName;
    }
  }

  const stateMachine: ASLStateMachine = {
    Comment: `Migrated from Conductor workflow: ${workflow.name} (v${workflow.version}). ${workflow.description || ''}`.trim(),
    StartAt: toStateName(tasks[0].taskReferenceName),
    States: states,
  };

  if (workflow.timeoutSeconds) {
    stateMachine.TimeoutSeconds = workflow.timeoutSeconds;
  }

  return {
    stateMachine,
    warnings,
    metadata: {
      sourceTaskCount: tasks.length,
      generatedStateCount: Object.keys(states).length,
      unsupportedConstructs,
    },
  };
}

interface TaskConversionResult {
  state?: ASLState;
  states?: Record<string, ASLState>;
}

function convertTask(
  task: ConductorTask,
  nextStateName: string | undefined,
  isLast: boolean,
  warnings: string[],
  unsupportedConstructs: string[]
): TaskConversionResult {
  switch (task.type) {
    case 'HTTP':
    case 'SIMPLE':
      return { state: convertHttpTask(task, nextStateName, isLast, warnings) };

    case 'DECISION':
    case 'SWITCH':
      return convertDecisionTask(task, warnings);

    case 'FORK_JOIN':
      return { state: convertForkJoinTask(task, nextStateName, isLast, warnings) };

    case 'WAIT':
      return { state: convertWaitTask(task, nextStateName, isLast) };

    case 'SUB_WORKFLOW':
      return { state: convertSubWorkflowTask(task, nextStateName, isLast, warnings) };

    case 'TERMINATE':
      return { state: convertTerminateTask(task) };

    default:
      unsupportedConstructs.push(task.type);
      warnings.push(
        `Task "${task.name}" uses unsupported type "${task.type}". Converted to a Pass state placeholder.`
      );
      return {
        state: {
          Type: 'Pass',
          Comment: `TODO: Manually convert Conductor ${task.type} task "${task.name}"`,
          ...(isLast ? { End: true } : { Next: nextStateName }),
        } as any,
      };
  }
}

/**
 * Convert HTTP/SIMPLE tasks to Lambda Task states
 * In Conductor, HTTP tasks call external endpoints (task workers).
 * In Step Functions, these become Lambda invocations or direct service integrations.
 */
function convertHttpTask(
  task: ConductorTask,
  nextStateName: string | undefined,
  isLast: boolean,
  warnings: string[]
): TaskState {
  const state: TaskState = {
    Type: 'Task',
    Resource: `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${task.name}`,
    Comment: `Migrated from Conductor ${task.type} task: ${task.name}`,
  };

  // Map input parameters
  if (task.inputParameters) {
    const params = mapInputParameters(task.inputParameters, warnings, task.name);
    if (Object.keys(params).length > 0) {
      state.Parameters = params;
    }
  }

  // Map timeout
  if (task.timeoutSeconds) {
    state.TimeoutSeconds = task.timeoutSeconds;
  }

  // Map retry
  if (task.retryCount && task.retryCount > 0) {
    state.Retry = [
      {
        ErrorEquals: ['States.ALL'],
        IntervalSeconds: 2,
        MaxAttempts: task.retryCount,
        BackoffRate: 2.0,
      },
    ];
  }

  // Add default error handling
  state.Catch = [
    {
      ErrorEquals: ['States.ALL'],
      Next: 'HandleError',
      ResultPath: '$.error',
    },
  ];

  // Set flow control
  if (isLast) {
    state.Next = 'WorkflowComplete';
  } else if (nextStateName) {
    state.Next = nextStateName;
  }

  return state;
}

/**
 * Convert DECISION/SWITCH tasks to Choice states
 */
function convertDecisionTask(
  task: ConductorTask,
  warnings: string[]
): TaskConversionResult {
  const states: Record<string, ASLState> = {};
  const choiceStateName = toStateName(task.taskReferenceName);

  if (!task.decisionCases) {
    warnings.push(`Decision task "${task.name}" has no decisionCases defined.`);
    return {
      state: {
        Type: 'Pass',
        Comment: `TODO: Decision task "${task.name}" had no cases`,
        End: true,
      } as any,
    };
  }

  const choices: any[] = [];

  for (const [caseValue, caseTasks] of Object.entries(task.decisionCases)) {
    const branchStateName = `${choiceStateName}_${caseValue}`;

    choices.push({
      Variable: `$.${task.caseValueParam || 'decisionValue'}`,
      StringEquals: caseValue,
      Next: branchStateName,
    });

    // Convert the branch tasks into states
    for (let i = 0; i < caseTasks.length; i++) {
      const branchTask = caseTasks[i];
      const branchTaskStateName =
        i === 0 ? branchStateName : toStateName(branchTask.taskReferenceName);
      const isLastInBranch = i === caseTasks.length - 1;
      const nextInBranch = isLastInBranch
        ? 'WorkflowComplete'
        : toStateName(caseTasks[i + 1].taskReferenceName);

      const result = convertTask(branchTask, nextInBranch, isLastInBranch, warnings, []);
      if (result.state) {
        states[branchTaskStateName] = result.state;
        if (isLastInBranch && !('End' in result.state)) {
          (result.state as any).Next = 'WorkflowComplete';
        }
      }
    }
  }

  const choiceState: ChoiceState = {
    Type: 'Choice',
    Choices: choices,
    Default: 'WorkflowComplete',
  };

  states[choiceStateName] = choiceState;

  return { states };
}

/**
 * Convert FORK_JOIN tasks to Parallel states
 */
function convertForkJoinTask(
  task: ConductorTask,
  nextStateName: string | undefined,
  isLast: boolean,
  warnings: string[]
): ParallelState {
  const branches: ASLStateMachine[] = [];

  if (task.forkTasks) {
    for (const branchTasks of task.forkTasks) {
      const branchStates: Record<string, ASLState> = {};

      for (let i = 0; i < branchTasks.length; i++) {
        const branchTask = branchTasks[i];
        const stateName = toStateName(branchTask.taskReferenceName);
        const isLastInBranch = i === branchTasks.length - 1;
        const nextInBranch = isLastInBranch
          ? undefined
          : toStateName(branchTasks[i + 1].taskReferenceName);

        const result = convertTask(branchTask, nextInBranch, isLastInBranch, warnings, []);
        if (result.state) {
          if (isLastInBranch) {
            (result.state as any).End = true;
            delete (result.state as any).Next;
          }
          branchStates[stateName] = result.state;
        }
      }

      if (Object.keys(branchStates).length > 0) {
        branches.push({
          StartAt: toStateName(branchTasks[0].taskReferenceName),
          States: branchStates,
        });
      }
    }
  }

  warnings.push(
    `Fork/Join task "${task.name}" converted to Parallel state. Verify branch independence.`
  );

  return {
    Type: 'Parallel',
    Branches: branches,
    ...(isLast ? { Next: 'WorkflowComplete' } : { Next: nextStateName }),
  } as ParallelState;
}

/**
 * Convert WAIT tasks to Wait states
 */
function convertWaitTask(
  task: ConductorTask,
  nextStateName: string | undefined,
  isLast: boolean
): WaitState {
  const state: WaitState = {
    Type: 'Wait',
    Seconds: task.timeoutSeconds || 60,
  };

  if (isLast) {
    state.Next = 'WorkflowComplete';
  } else if (nextStateName) {
    state.Next = nextStateName;
  }

  return state;
}

/**
 * Convert SUB_WORKFLOW tasks to nested Step Functions execution
 */
function convertSubWorkflowTask(
  task: ConductorTask,
  nextStateName: string | undefined,
  isLast: boolean,
  warnings: string[]
): TaskState {
  warnings.push(
    `Sub-workflow task "${task.name}" references "${task.subWorkflowParam?.name}". ` +
      `You'll need to migrate that workflow separately and update the ARN.`
  );

  return {
    Type: 'Task',
    Resource: 'arn:aws:states:::states:startExecution.sync:2',
    Parameters: {
      StateMachineArn: `arn:aws:states:\${AWS::Region}:\${AWS::AccountId}:stateMachine:${task.subWorkflowParam?.name || 'UNKNOWN'}`,
      Input: { 'AWS_STEP_FUNCTIONS_STARTED_BY_EXECUTION_ID.$': '$$.Execution.Id' },
    },
    Comment: `Migrated from Conductor SUB_WORKFLOW: ${task.subWorkflowParam?.name}`,
    ...(isLast ? { Next: 'WorkflowComplete' } : { Next: nextStateName }),
  } as TaskState;
}

/**
 * Convert TERMINATE tasks to Fail states
 */
function convertTerminateTask(task: ConductorTask): FailState {
  return {
    Type: 'Fail',
    Error: 'WorkflowTerminated',
    Cause: `Conductor TERMINATE task: ${task.name}`,
  } as FailState;
}

/**
 * Map Conductor input parameters to Step Functions Parameters
 * Converts ${workflow.input.*} references to JsonPath ($.*)
 */
function mapInputParameters(
  params: Record<string, any>,
  warnings: string[],
  taskName: string
): Record<string, any> {
  const mapped: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    if (key === 'http_request') {
      // Extract the body from HTTP request params — that's what the Lambda needs
      if (value && typeof value === 'object' && value.body) {
        return mapInputParameters(value.body, warnings, taskName);
      }
      continue;
    }

    if (typeof value === 'string' && value.includes('${')) {
      // Convert Conductor expression to JsonPath
      const jsonPath = convertConductorExpression(value);
      mapped[`${key}.$`] = jsonPath;
    } else if (typeof value === 'object' && value !== null) {
      mapped[key] = mapInputParameters(value, warnings, taskName);
    } else {
      mapped[key] = value;
    }
  }

  return mapped;
}

/**
 * Convert Conductor expression syntax to Step Functions JsonPath
 * ${workflow.input.foo} → $.foo
 * ${taskRef.output.bar} → $.taskRef.bar
 */
function convertConductorExpression(expr: string): string {
  // ${workflow.input.fieldName} → $.fieldName
  let result = expr.replace(
    /\$\{workflow\.input\.([^}]+)\}/g,
    '$.$1'
  );

  // ${taskRef.output.response.body.field} → $.taskRef.field
  result = result.replace(
    /\$\{([^.]+)\.output\.(?:response\.body\.)?([^}]+)\}/g,
    '$.$1.$2'
  );

  // If the entire string is a single expression, return just the path
  if (result.startsWith('$.') && !result.includes(' ')) {
    return result;
  }

  return result;
}

/**
 * Convert a Conductor taskReferenceName to a valid ASL state name
 */
function toStateName(ref: string): string {
  return ref
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}
