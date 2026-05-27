/**
 * Camunda BPMN 2.0 workflow definition types
 * Represents the parsed structure of a Camunda BPMN XML file.
 *
 * Scope: Camunda 7 (Community and Enterprise). Camunda 8 (Zeebe) uses
 * a different execution model and is not covered here.
 */

/** Top-level BPMN process definition */
export interface CamundaProcess {
  id: string;
  name: string;
  isExecutable: boolean;
  elements: BPMNElement[];
  sequenceFlows: SequenceFlow[];
}

/** Union of all supported BPMN element types */
export type BPMNElement =
  | StartEvent
  | EndEvent
  | ServiceTask
  | UserTask
  | ExclusiveGateway
  | ParallelGateway
  | InclusiveGateway
  | IntermediateTimerEvent
  | BoundaryEvent
  | SubProcess;

/** Base properties shared by all BPMN elements */
export interface BaseBPMNElement {
  id: string;
  name?: string;
  incoming?: string[];
  outgoing?: string[];
}

export interface StartEvent extends BaseBPMNElement {
  type: 'startEvent';
}

export interface EndEvent extends BaseBPMNElement {
  type: 'endEvent';
}

export interface ServiceTask extends BaseBPMNElement {
  type: 'serviceTask';
  /** Camunda external task topic name */
  topic?: string;
  /** Camunda task type (external, expression, delegate) */
  taskType?: 'external' | 'expression' | 'delegate';
  /** Retry configuration (e.g., "R3/PT5S") */
  retries?: string;
  /** Input/output parameters from Camunda extensions */
  inputParameters?: Record<string, string>;
  outputParameters?: Record<string, string>;
  /** Error boundary events attached to this task */
  boundaryEvents?: BoundaryEvent[];
}

export interface UserTask extends BaseBPMNElement {
  type: 'userTask';
  assignee?: string;
  candidateGroups?: string;
  formKey?: string;
}

export interface ExclusiveGateway extends BaseBPMNElement {
  type: 'exclusiveGateway';
  /** Default sequence flow ID (for the "otherwise" path) */
  default?: string;
}

export interface ParallelGateway extends BaseBPMNElement {
  type: 'parallelGateway';
}

export interface InclusiveGateway extends BaseBPMNElement {
  type: 'inclusiveGateway';
  default?: string;
}

export interface IntermediateTimerEvent extends BaseBPMNElement {
  type: 'intermediateTimerEvent';
  /** ISO 8601 duration (e.g., "PT30S", "PT5M") */
  duration?: string;
}

export interface BoundaryEvent extends BaseBPMNElement {
  type: 'boundaryEvent';
  attachedToRef: string;
  cancelActivity: boolean;
  /** Error code for error boundary events */
  errorCode?: string;
  /** Timer duration for timer boundary events */
  timerDuration?: string;
  eventType: 'error' | 'timer' | 'message';
}

export interface SubProcess extends BaseBPMNElement {
  type: 'subProcess';
  elements: BPMNElement[];
  sequenceFlows: SequenceFlow[];
}

/** Sequence flow connecting two BPMN elements */
export interface SequenceFlow {
  id: string;
  sourceRef: string;
  targetRef: string;
  name?: string;
  /** Condition expression (e.g., "${mediaType == 'video'}") */
  conditionExpression?: string;
}
