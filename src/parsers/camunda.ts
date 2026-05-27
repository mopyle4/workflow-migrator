import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import {
  CamundaProcess,
  BPMNElement,
  SequenceFlow,
  ServiceTask,
  BoundaryEvent,
} from '../types/camunda';
import { ParseError, ValidationError, WorkflowMigratorError, ErrorCode } from '../utils/errors';
import { MAX_INPUT_FILE_SIZE_BYTES } from '../utils/constants';
import { logger } from '../utils/logger';

/**
 * Parse and validate a Camunda BPMN 2.0 XML workflow definition.
 *
 * Security:
 *   - Validates file size before reading (prevent memory exhaustion)
 *   - Uses fast-xml-parser which does NOT resolve external entities (safe from XXE)
 *   - Validates structure before processing
 *
 * @param input - File path to a Camunda BPMN XML file
 * @returns Validated CamundaProcess object
 */
export function parseCamundaWorkflow(input: string): CamundaProcess {
  logger.debug('Parsing Camunda BPMN workflow', { input });

  // Validate file exists
  if (!fs.existsSync(input)) {
    throw new WorkflowMigratorError(
      ErrorCode.FILE_NOT_FOUND,
      `Input file not found: ${input}`,
      { path: input }
    );
  }

  // Security: Check file size before reading
  const stats = fs.statSync(input);
  if (stats.size > MAX_INPUT_FILE_SIZE_BYTES) {
    throw new WorkflowMigratorError(
      ErrorCode.FILE_TOO_LARGE,
      `Input file exceeds maximum size of ${MAX_INPUT_FILE_SIZE_BYTES / 1024 / 1024}MB`,
      { path: input, size: stats.size }
    );
  }

  // Read file
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(input, 'utf-8');
  } catch (err: any) {
    throw new ParseError(`Failed to read file: ${err.message}`, { path: input });
  }

  // Parse XML (fast-xml-parser does not resolve external entities — safe from XXE)
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => BPMN_ARRAY_ELEMENTS.has(name),
  });

  let parsed: any;
  try {
    parsed = parser.parse(rawContent);
  } catch (err: any) {
    throw new ParseError(`Invalid BPMN XML: ${err.message}`, { path: input });
  }

  // Extract the process definition
  const definitions = parsed['bpmn:definitions'] || parsed['definitions'] || parsed;
  if (!definitions) {
    throw new ValidationError('BPMN file missing <definitions> root element');
  }

  const processElement = definitions['bpmn:process'] || definitions['process'];
  if (!processElement) {
    throw new ValidationError('BPMN file missing <process> element');
  }

  // Handle single process or array of processes (take the executable one)
  const process = Array.isArray(processElement)
    ? processElement.find((p: any) => p['@_isExecutable'] === 'true') || processElement[0]
    : processElement;

  const camundaProcess = extractProcess(process);

  logger.debug('Successfully parsed BPMN workflow', {
    name: camundaProcess.name,
    elementCount: camundaProcess.elements.length,
    flowCount: camundaProcess.sequenceFlows.length,
  });

  return camundaProcess;
}

/** BPMN elements that can appear multiple times and should always be arrays */
const BPMN_ARRAY_ELEMENTS = new Set([
  'bpmn:sequenceFlow', 'sequenceFlow',
  'bpmn:serviceTask', 'serviceTask',
  'bpmn:userTask', 'userTask',
  'bpmn:exclusiveGateway', 'exclusiveGateway',
  'bpmn:parallelGateway', 'parallelGateway',
  'bpmn:inclusiveGateway', 'inclusiveGateway',
  'bpmn:boundaryEvent', 'boundaryEvent',
  'bpmn:startEvent', 'startEvent',
  'bpmn:endEvent', 'endEvent',
  'bpmn:intermediateCatchEvent', 'intermediateCatchEvent',
  'bpmn:subProcess', 'subProcess',
  'bpmn:incoming', 'incoming',
  'bpmn:outgoing', 'outgoing',
  'camunda:inputParameter', 'inputParameter',
  'camunda:outputParameter', 'outputParameter',
]);

/**
 * Extract a CamundaProcess from the parsed XML process element.
 */
function extractProcess(process: any): CamundaProcess {
  const id = process['@_id'] || 'unknown';
  const name = process['@_name'] || id;
  const isExecutable = process['@_isExecutable'] === 'true';

  const elements: BPMNElement[] = [];
  const sequenceFlows: SequenceFlow[] = [];

  // Extract sequence flows
  const flows = getArray(process, 'bpmn:sequenceFlow', 'sequenceFlow');
  for (const flow of flows) {
    sequenceFlows.push(extractSequenceFlow(flow));
  }

  // Extract start events
  for (const el of getArray(process, 'bpmn:startEvent', 'startEvent')) {
    elements.push({
      type: 'startEvent',
      id: el['@_id'],
      name: el['@_name'],
      incoming: extractFlowRefs(el, 'incoming'),
      outgoing: extractFlowRefs(el, 'outgoing'),
    });
  }

  // Extract end events
  for (const el of getArray(process, 'bpmn:endEvent', 'endEvent')) {
    elements.push({
      type: 'endEvent',
      id: el['@_id'],
      name: el['@_name'],
      incoming: extractFlowRefs(el, 'incoming'),
      outgoing: extractFlowRefs(el, 'outgoing'),
    });
  }

  // Extract service tasks
  for (const el of getArray(process, 'bpmn:serviceTask', 'serviceTask')) {
    elements.push(extractServiceTask(el));
  }

  // Extract user tasks
  for (const el of getArray(process, 'bpmn:userTask', 'userTask')) {
    elements.push({
      type: 'userTask',
      id: el['@_id'],
      name: el['@_name'],
      assignee: el['@_camunda:assignee'],
      candidateGroups: el['@_camunda:candidateGroups'],
      formKey: el['@_camunda:formKey'],
      incoming: extractFlowRefs(el, 'incoming'),
      outgoing: extractFlowRefs(el, 'outgoing'),
    });
  }

  // Extract exclusive gateways
  for (const el of getArray(process, 'bpmn:exclusiveGateway', 'exclusiveGateway')) {
    elements.push({
      type: 'exclusiveGateway',
      id: el['@_id'],
      name: el['@_name'],
      default: el['@_default'],
      incoming: extractFlowRefs(el, 'incoming'),
      outgoing: extractFlowRefs(el, 'outgoing'),
    });
  }

  // Extract parallel gateways
  for (const el of getArray(process, 'bpmn:parallelGateway', 'parallelGateway')) {
    elements.push({
      type: 'parallelGateway',
      id: el['@_id'],
      name: el['@_name'],
      incoming: extractFlowRefs(el, 'incoming'),
      outgoing: extractFlowRefs(el, 'outgoing'),
    });
  }

  // Extract inclusive gateways
  for (const el of getArray(process, 'bpmn:inclusiveGateway', 'inclusiveGateway')) {
    elements.push({
      type: 'inclusiveGateway',
      id: el['@_id'],
      name: el['@_name'],
      default: el['@_default'],
      incoming: extractFlowRefs(el, 'incoming'),
      outgoing: extractFlowRefs(el, 'outgoing'),
    });
  }

  // Extract boundary events
  for (const el of getArray(process, 'bpmn:boundaryEvent', 'boundaryEvent')) {
    elements.push(extractBoundaryEvent(el));
  }

  // Validate we found at least a start event and one task
  if (!elements.some(e => e.type === 'startEvent')) {
    throw new ValidationError(`Process "${name}": no start event found`);
  }

  return { id, name, isExecutable, elements, sequenceFlows };
}

/** Extract a service task with Camunda-specific extensions */
function extractServiceTask(el: any): ServiceTask {
  const extensionElements = el['bpmn:extensionElements'] || el['extensionElements'];
  const inputOutput = extensionElements?.['camunda:inputOutput'];

  let topic: string | undefined;
  let taskType: ServiceTask['taskType'] = 'external';

  // Camunda 7 external task topic
  if (el['@_camunda:type'] === 'external') {
    topic = el['@_camunda:topic'];
    taskType = 'external';
  } else if (el['@_camunda:delegateExpression']) {
    taskType = 'delegate';
  } else if (el['@_camunda:expression']) {
    taskType = 'expression';
  }

  // Extract input/output parameters
  const inputParameters: Record<string, string> = {};
  const outputParameters: Record<string, string> = {};

  if (inputOutput) {
    const inputs = getArray(inputOutput, 'camunda:inputParameter', 'inputParameter');
    for (const param of inputs) {
      const name = param['@_name'];
      const value = typeof param === 'object' ? (param['#text'] || '') : String(param);
      if (name) inputParameters[name] = value;
    }

    const outputs = getArray(inputOutput, 'camunda:outputParameter', 'outputParameter');
    for (const param of outputs) {
      const name = param['@_name'];
      const value = typeof param === 'object' ? (param['#text'] || '') : String(param);
      if (name) outputParameters[name] = value;
    }
  }

  return {
    type: 'serviceTask',
    id: el['@_id'],
    name: el['@_name'],
    topic,
    taskType,
    retries: el['@_camunda:asyncBefore'] ? 'R3/PT10S' : undefined,
    inputParameters: Object.keys(inputParameters).length > 0 ? inputParameters : undefined,
    outputParameters: Object.keys(outputParameters).length > 0 ? outputParameters : undefined,
    incoming: extractFlowRefs(el, 'incoming'),
    outgoing: extractFlowRefs(el, 'outgoing'),
  };
}

/** Extract a boundary event (error or timer) */
function extractBoundaryEvent(el: any): BoundaryEvent {
  const attachedToRef = el['@_attachedToRef'];
  const cancelActivity = el['@_cancelActivity'] !== 'false';

  let eventType: BoundaryEvent['eventType'] = 'error';
  let errorCode: string | undefined;
  let timerDuration: string | undefined;

  const errorDef = el['bpmn:errorEventDefinition'] || el['errorEventDefinition'];
  if (errorDef) {
    eventType = 'error';
    errorCode = errorDef['@_errorRef'];
  }

  const timerDef = el['bpmn:timerEventDefinition'] || el['timerEventDefinition'];
  if (timerDef) {
    eventType = 'timer';
    timerDuration = timerDef['bpmn:timeDuration'] || timerDef['timeDuration'];
    if (typeof timerDuration === 'object') {
      timerDuration = timerDuration['#text'] || undefined;
    }
  }

  const messageDef = el['bpmn:messageEventDefinition'] || el['messageEventDefinition'];
  if (messageDef) {
    eventType = 'message';
  }

  return {
    type: 'boundaryEvent',
    id: el['@_id'],
    name: el['@_name'],
    attachedToRef,
    cancelActivity,
    errorCode,
    timerDuration,
    eventType,
    incoming: extractFlowRefs(el, 'incoming'),
    outgoing: extractFlowRefs(el, 'outgoing'),
  };
}

/** Extract a sequence flow */
function extractSequenceFlow(flow: any): SequenceFlow {
  const conditionExpr = flow['bpmn:conditionExpression'] || flow['conditionExpression'];
  let conditionExpression: string | undefined;

  if (conditionExpr) {
    conditionExpression = typeof conditionExpr === 'object'
      ? conditionExpr['#text']
      : String(conditionExpr);
  }

  return {
    id: flow['@_id'],
    sourceRef: flow['@_sourceRef'],
    targetRef: flow['@_targetRef'],
    name: flow['@_name'],
    conditionExpression,
  };
}

/** Helper: get an element as an array regardless of whether XML had one or many */
function getArray(parent: any, prefixedName: string, unprefixedName: string): any[] {
  const value = parent[prefixedName] || parent[unprefixedName];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** Helper: extract incoming/outgoing flow references */
function extractFlowRefs(el: any, direction: 'incoming' | 'outgoing'): string[] {
  const prefixed = el[`bpmn:${direction}`] || el[direction];
  if (!prefixed) return [];
  if (Array.isArray(prefixed)) return prefixed.map(String);
  return [String(prefixed)];
}
