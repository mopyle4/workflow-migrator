import {
  CamundaProcess,
  BPMNElement,
  SequenceFlow,
  ServiceTask,
  ExclusiveGateway,
  ParallelGateway,
  BoundaryEvent,
  UserTask,
} from '../types/camunda';
import {
  ASLStateMachine,
  ASLState,
  TaskState,
  ChoiceState,
  ChoiceRule,
  ParallelState,
  WaitState,
  FailState,
  PassState,
  SucceedState,
  RetryConfig,
  CatchConfig,
} from '../types/asl';
import { ConversionResult } from './conductor-to-asl';
import { logger } from '../utils/logger';

/**
 * Convert a Camunda BPMN 2.0 process to AWS Step Functions ASL.
 *
 * Strategy: Walk the BPMN graph from the start event, following sequence flows,
 * and generate ASL states for each element encountered. Gateways become Choice
 * or Parallel states, service tasks become Lambda Task states, and boundary
 * events become Catch/Timeout configurations.
 */
export function convertCamundaToASL(process: CamundaProcess): ConversionResult {
  const warnings: string[] = [];
  const unsupportedConstructs: string[] = [];
  const states: Record<string, ASLState> = {};

  // Build lookup maps for efficient graph traversal
  const elMap = new Map<string, BPMNElement>();
  const outgoingFlows = new Map<string, SequenceFlow[]>();
  const boundaryEventsMap = new Map<string, BoundaryEvent[]>();

  for (const el of process.elements) {
    elMap.set(el.id, el);
    if (el.type === 'boundaryEvent') {
      const existing = boundaryEventsMap.get(el.attachedToRef) || [];
      existing.push(el);
      boundaryEventsMap.set(el.attachedToRef, existing);
    }
  }

  for (const flow of process.sequenceFlows) {
    const existing = outgoingFlows.get(flow.sourceRef) || [];
    existing.push(flow);
    outgoingFlows.set(flow.sourceRef, existing);
  }

  // Find the start event
  const startEvent = process.elements.find(e => e.type === 'startEvent');
  if (!startEvent) {
    warnings.push('No start event found — using first element as entry point');
  }

  const startElementId = startEvent?.id || process.elements[0].id;
  const firstTargetFlow = outgoingFlows.get(startElementId)?.[0];
  const firstElementId = firstTargetFlow?.targetRef;

  if (!firstElementId) {
    warnings.push('Start event has no outgoing flow');
    return {
      stateMachine: { Comment: 'Empty workflow', StartAt: 'End', States: { End: { Type: 'Succeed' } as SucceedState } },
      warnings,
      metadata: { sourceTaskCount: 0, generatedStateCount: 1, unsupportedConstructs },
    };
  }

  // Recursive graph walk
  const visited = new Set<string>();

  function walkElement(elementId: string): string | undefined {
    if (visited.has(elementId)) {
      const el = elMap.get(elementId);
      return el ? toStateName(el) : undefined;
    }
    visited.add(elementId);

    const element = elMap.get(elementId);
    if (!element) {
      warnings.push(`Element "${elementId}" referenced but not found in process`);
      return undefined;
    }

    const stateName = toStateName(element);
    const outFlows = outgoingFlows.get(elementId) || [];

    switch (element.type) {
      case 'serviceTask': {
        states[stateName] = convertServiceTask(element, boundaryEventsMap.get(elementId));
        if (outFlows.length === 1) {
          const nextEl = elMap.get(outFlows[0].targetRef);
          if (nextEl && nextEl.type !== 'endEvent') {
            const nextName = walkElement(outFlows[0].targetRef);
            if (nextName) (states[stateName] as any).Next = nextName;
          } else {
            (states[stateName] as any).Next = 'WorkflowComplete';
          }
        } else {
          (states[stateName] as any).Next = 'WorkflowComplete';
        }
        break;
      }

      case 'userTask': {
        states[stateName] = convertUserTask(element, warnings);
        if (outFlows.length === 1) {
          const nextEl = elMap.get(outFlows[0].targetRef);
          if (nextEl && nextEl.type !== 'endEvent') {
            const nextName = walkElement(outFlows[0].targetRef);
            if (nextName) (states[stateName] as any).Next = nextName;
          } else {
            (states[stateName] as any).Next = 'WorkflowComplete';
          }
        }
        break;
      }

      case 'exclusiveGateway': {
        states[stateName] = convertExclusiveGateway(element, outFlows, elMap, warnings);
        for (const flow of outFlows) {
          const targetEl = elMap.get(flow.targetRef);
          if (targetEl && targetEl.type !== 'endEvent') {
            walkElement(flow.targetRef);
          }
        }
        break;
      }

      case 'parallelGateway': {
        if (outFlows.length > 1) {
          // Diverging gateway
          states[stateName] = convertParallelGateway(element, outFlows, elMap, warnings);
          // Find converging gateway and walk after it
          const convergingGw = findConvergingGateway(elementId);
          if (convergingGw) {
            const afterFlows = outgoingFlows.get(convergingGw.id) || [];
            if (afterFlows.length === 1) {
              const nextEl = elMap.get(afterFlows[0].targetRef);
              if (nextEl && nextEl.type !== 'endEvent') {
                visited.add(convergingGw.id); // Mark converging as visited
                const nextName = walkElement(afterFlows[0].targetRef);
                if (nextName) (states[stateName] as any).Next = nextName;
              } else {
                (states[stateName] as any).Next = 'WorkflowComplete';
              }
            }
          } else {
            (states[stateName] as any).Next = 'WorkflowComplete';
          }
        } else if (outFlows.length === 1) {
          // Converging gateway — skip, walk next
          const nextEl = elMap.get(outFlows[0].targetRef);
          if (nextEl && nextEl.type !== 'endEvent') {
            return walkElement(outFlows[0].targetRef);
          }
          return 'WorkflowComplete';
        }
        break;
      }

      case 'endEvent':
        return 'WorkflowComplete';

      case 'startEvent': {
        if (outFlows.length === 1) {
          return walkElement(outFlows[0].targetRef);
        }
        break;
      }

      default: {
        unsupportedConstructs.push(element.type);
        warnings.push(`Element "${element.id}" has unsupported type "${element.type}". Converted to Pass state.`);
        states[stateName] = {
          Type: 'Pass',
          Comment: `TODO: Manually convert BPMN ${element.type} element "${element.id}"`,
        } as PassState;
        if (outFlows.length === 1) {
          const nextEl = elMap.get(outFlows[0].targetRef);
          if (nextEl && nextEl.type !== 'endEvent') {
            const nextName = walkElement(outFlows[0].targetRef);
            if (nextName) (states[stateName] as any).Next = nextName;
          } else {
            (states[stateName] as any).Next = 'WorkflowComplete';
          }
        } else {
          (states[stateName] as any).Next = 'WorkflowComplete';
        }
        break;
      }
    }

    return stateName;
  }

  function findConvergingGateway(divergingId: string): BPMNElement | undefined {
    for (const el of process.elements) {
      if (el.type === 'parallelGateway' && el.id !== divergingId) {
        const incoming = el.incoming || [];
        if (incoming.length > 1) return el;
      }
    }
    return undefined;
  }

  walkElement(firstElementId);

  // Add terminal states
  states['WorkflowComplete'] = { Type: 'Succeed' } as SucceedState;
  states['HandleError'] = {
    Type: 'Fail',
    Error: 'WorkflowError',
    Cause: 'An error occurred during workflow execution. Check CloudWatch Logs for details.',
  } as FailState;

  const firstElement = elMap.get(firstElementId);
  const startStateName = firstElement ? toStateName(firstElement) : 'WorkflowComplete';

  const stateMachine: ASLStateMachine = {
    Comment: `Migrated from Camunda BPMN process: ${process.name} (${process.id})`,
    StartAt: startStateName,
    States: states,
  };

  return {
    stateMachine,
    warnings,
    metadata: {
      sourceTaskCount: process.elements.filter(e => e.type === 'serviceTask' || e.type === 'userTask').length,
      generatedStateCount: Object.keys(states).length,
      unsupportedConstructs,
    },
  };
}

/** Convert a Camunda service task to a Step Functions Task state */
function convertServiceTask(task: ServiceTask, boundaries?: BoundaryEvent[]): TaskState {
  const functionName = task.topic || task.name || task.id;

  const state: TaskState = {
    Type: 'Task',
    Resource: `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${functionName}`,
    Comment: `Migrated from Camunda service task: ${task.name || task.id} (topic: ${task.topic || 'N/A'})`,
  };

  // Map input parameters
  if (task.inputParameters && Object.keys(task.inputParameters).length > 0) {
    state.Parameters = {};
    for (const [key, value] of Object.entries(task.inputParameters)) {
      if (value.includes('${')) {
        state.Parameters[`${key}.$`] = convertCamundaExpression(value);
      } else {
        state.Parameters[key] = value;
      }
    }
  }

  // Map retry from Camunda retries config
  const retryConfig = parseRetryConfig(task.retries);
  if (retryConfig) {
    state.Retry = [retryConfig];
  } else {
    state.Retry = [{
      ErrorEquals: ['States.TaskFailed', 'States.Timeout'],
      IntervalSeconds: 2,
      MaxAttempts: 2,
      BackoffRate: 2.0,
    }];
  }

  // Map boundary events to Catch blocks and TimeoutSeconds
  if (boundaries && boundaries.length > 0) {
    const catchConfigs: CatchConfig[] = [];
    for (const boundary of boundaries) {
      if (boundary.eventType === 'error') {
        catchConfigs.push({
          ErrorEquals: [boundary.errorCode || 'States.ALL'],
          Next: 'HandleError',
          ResultPath: '$.error',
        });
      } else if (boundary.eventType === 'timer' && boundary.timerDuration) {
        const seconds = parseISO8601Duration(boundary.timerDuration);
        if (seconds) state.TimeoutSeconds = seconds;
      }
    }
    state.Catch = catchConfigs.length > 0
      ? catchConfigs
      : [{ ErrorEquals: ['States.ALL'], Next: 'HandleError', ResultPath: '$.error' }];
  } else {
    state.Catch = [{ ErrorEquals: ['States.ALL'], Next: 'HandleError', ResultPath: '$.error' }];
  }

  return state;
}

/** Convert a Camunda user task to a Step Functions Task with waitForTaskToken */
function convertUserTask(task: UserTask, warnings: string[]): TaskState {
  warnings.push(
    `User task "${task.name || task.id}" converted to waitForTaskToken pattern. ` +
    `You must build a callback API and UI to resume the execution.`
  );

  return {
    Type: 'Task',
    Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
    Parameters: {
      FunctionName: `\${AWS::AccountId}-send-task-notification`,
      Payload: {
        'taskToken.$': '$$.Task.Token',
        'taskName': task.name || task.id,
        'assignee': task.assignee || 'unassigned',
        'candidateGroups': task.candidateGroups || '',
      },
    },
    Comment: `Migrated from Camunda user task: ${task.name || task.id}. Requires custom callback API.`,
    Catch: [{ ErrorEquals: ['States.ALL'], Next: 'HandleError', ResultPath: '$.error' }],
  } as TaskState;
}

/** Convert a Camunda exclusive gateway to a Step Functions Choice state */
function convertExclusiveGateway(
  gateway: ExclusiveGateway,
  outFlows: SequenceFlow[],
  elMap: Map<string, BPMNElement>,
  warnings: string[],
): ChoiceState {
  const choices: ChoiceRule[] = [];
  let defaultTarget = 'WorkflowComplete';

  for (const flow of outFlows) {
    if (flow.id === gateway.default) {
      const targetEl = elMap.get(flow.targetRef);
      defaultTarget = targetEl ? toStateName(targetEl) : 'WorkflowComplete';
      continue;
    }

    if (flow.conditionExpression) {
      const rule = convertConditionToChoiceRule(flow.conditionExpression, flow.targetRef, elMap);
      if (rule) {
        choices.push(rule);
      } else {
        warnings.push(
          `Gateway "${gateway.name || gateway.id}": could not parse condition "${flow.conditionExpression}". Added placeholder.`
        );
        const targetEl = elMap.get(flow.targetRef);
        choices.push({
          Variable: '$.condition',
          StringEquals: flow.name || flow.targetRef,
          Next: targetEl ? toStateName(targetEl) : 'WorkflowComplete',
        });
      }
    } else if (!gateway.default) {
      const targetEl = elMap.get(flow.targetRef);
      defaultTarget = targetEl ? toStateName(targetEl) : 'WorkflowComplete';
    }
  }

  return {
    Type: 'Choice',
    Comment: `Migrated from Camunda exclusive gateway: ${gateway.name || gateway.id}`,
    Choices: choices,
    Default: defaultTarget,
  };
}

/** Convert a Camunda parallel gateway to a Step Functions Parallel state */
function convertParallelGateway(
  gateway: ParallelGateway,
  outFlows: SequenceFlow[],
  elMap: Map<string, BPMNElement>,
  warnings: string[],
): ParallelState {
  warnings.push(
    `Parallel gateway "${gateway.name || gateway.id}" converted to Parallel state. ` +
    `Verify branch independence.`
  );

  const branches: ASLStateMachine[] = outFlows.map(flow => {
    const targetEl = elMap.get(flow.targetRef);
    const branchStateName = targetEl ? toStateName(targetEl) : 'BranchTask';

    return {
      StartAt: branchStateName,
      States: {
        [branchStateName]: {
          Type: 'Task',
          Resource: `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${targetEl?.name || flow.targetRef}`,
          Comment: `Branch: ${targetEl?.name || flow.targetRef}`,
          End: true,
        } as TaskState,
      },
    };
  });

  return {
    Type: 'Parallel',
    Branches: branches,
    Comment: `Migrated from Camunda parallel gateway: ${gateway.name || gateway.id}`,
  } as ParallelState;
}

/** Convert a Camunda condition expression to a Step Functions Choice rule */
function convertConditionToChoiceRule(
  expression: string,
  targetRef: string,
  elMap: Map<string, BPMNElement>,
): ChoiceRule | null {
  const targetEl = elMap.get(targetRef);
  const nextState = targetEl ? toStateName(targetEl) : 'WorkflowComplete';

  // Pattern: ${variable == 'value'} or ${variable == "value"}
  const stringMatch = expression.match(/\$\{(\w+(?:\.\w+)*)\s*==\s*['"]([^'"]+)['"]\}/);
  if (stringMatch) {
    return { Variable: `$.${stringMatch[1]}`, StringEquals: stringMatch[2], Next: nextState };
  }

  // Pattern: ${variable == number}
  const numericMatch = expression.match(/\$\{(\w+(?:\.\w+)*)\s*==\s*(\d+)\}/);
  if (numericMatch) {
    return { Variable: `$.${numericMatch[1]}`, NumericEquals: parseInt(numericMatch[2], 10), Next: nextState };
  }

  return null;
}

/** Convert Camunda expression syntax to Step Functions JsonPath */
function convertCamundaExpression(expr: string): string {
  let result = expr.replace(/\$\{execution\.(\w+)\}/g, '$.$1');
  result = result.replace(/\$\{(\w+(?:\.\w+)*)\}/g, '$.$1');
  return result;
}

/** Parse Camunda retry config (e.g., "R3/PT5S") to ASL RetryConfig */
function parseRetryConfig(retries?: string): RetryConfig | null {
  if (!retries) return null;
  const match = retries.match(/R(\d+)\/PT(\d+)([SM])/);
  if (!match) return null;

  const maxAttempts = parseInt(match[1], 10);
  let intervalSeconds = parseInt(match[2], 10);
  if (match[3] === 'M') intervalSeconds *= 60;

  return {
    ErrorEquals: ['States.TaskFailed', 'States.Timeout'],
    IntervalSeconds: intervalSeconds,
    MaxAttempts: maxAttempts,
    BackoffRate: 2.0,
  };
}

/** Parse ISO 8601 duration to seconds */
function parseISO8601Duration(duration: string): number | null {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  return parseInt(match[1] || '0', 10) * 3600 +
         parseInt(match[2] || '0', 10) * 60 +
         parseInt(match[3] || '0', 10);
}

/** Generate a clean ASL state name from a BPMN element */
function toStateName(element: BPMNElement): string {
  const name = element.name || element.id;
  return name
    .replace(/[^a-zA-Z0-9\s_-]/g, '')
    .split(/[\s_-]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}
