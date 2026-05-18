import * as fs from 'fs';
import { ConductorWorkflow, ConductorTask } from '../types/conductor';
import { ParseError, ValidationError, WorkflowMigratorError, ErrorCode } from '../utils/errors';
import { MAX_INPUT_FILE_SIZE_BYTES, MAX_WORKFLOW_TASKS } from '../utils/constants';
import { logger } from '../utils/logger';

/**
 * Parse and validate a Netflix Conductor workflow JSON definition.
 *
 * Security: Validates file size before reading to prevent memory exhaustion.
 * Validates structure before processing to fail fast on malformed input.
 *
 * @param input - File path to a Conductor workflow JSON file
 * @returns Validated ConductorWorkflow object
 * @throws ParseError if JSON is malformed
 * @throws ValidationError if workflow structure is invalid
 * @throws WorkflowMigratorError if file is not found or too large
 */
export function parseConductorWorkflow(input: string): ConductorWorkflow {
  logger.debug('Parsing Conductor workflow', { input });

  // Validate file exists
  if (!fs.existsSync(input)) {
    throw new WorkflowMigratorError(
      ErrorCode.FILE_NOT_FOUND,
      `Input file not found: ${input}`,
      { path: input }
    );
  }

  // Security: Check file size before reading (prevent memory exhaustion)
  const stats = fs.statSync(input);
  if (stats.size > MAX_INPUT_FILE_SIZE_BYTES) {
    throw new WorkflowMigratorError(
      ErrorCode.FILE_TOO_LARGE,
      `Input file exceeds maximum size of ${MAX_INPUT_FILE_SIZE_BYTES / 1024 / 1024}MB: ${stats.size} bytes`,
      { path: input, size: stats.size, maxSize: MAX_INPUT_FILE_SIZE_BYTES }
    );
  }

  // Parse JSON
  let rawContent: string;
  let workflow: ConductorWorkflow;

  try {
    rawContent = fs.readFileSync(input, 'utf-8');
  } catch (err: any) {
    throw new ParseError(`Failed to read file: ${err.message}`, { path: input });
  }

  try {
    workflow = JSON.parse(rawContent);
  } catch (err: any) {
    throw new ParseError(
      `Invalid JSON in workflow file: ${err.message}`,
      { path: input, position: err.message }
    );
  }

  // Validate workflow structure
  validateWorkflowStructure(workflow);

  logger.debug('Successfully parsed workflow', {
    name: workflow.name,
    taskCount: workflow.tasks.length,
  });

  return workflow;
}

/**
 * Validate the structural integrity of a parsed Conductor workflow.
 * Fails fast with descriptive errors for each validation rule.
 */
function validateWorkflowStructure(workflow: ConductorWorkflow): void {
  if (!workflow || typeof workflow !== 'object') {
    throw new ValidationError('Workflow must be a JSON object');
  }

  if (!workflow.name || typeof workflow.name !== 'string') {
    throw new ValidationError('Workflow missing required "name" field (string)');
  }

  if (!workflow.tasks || !Array.isArray(workflow.tasks)) {
    throw new ValidationError(
      `Workflow "${workflow.name}": missing or invalid "tasks" array`
    );
  }

  if (workflow.tasks.length === 0) {
    throw new ValidationError(`Workflow "${workflow.name}": "tasks" array is empty`);
  }

  if (workflow.tasks.length > MAX_WORKFLOW_TASKS) {
    throw new ValidationError(
      `Workflow "${workflow.name}": exceeds maximum of ${MAX_WORKFLOW_TASKS} tasks (found ${workflow.tasks.length})`,
    );
  }

  // Validate each task
  const taskRefs = new Set<string>();
  for (const task of workflow.tasks) {
    validateTask(task, taskRefs, workflow.name);
  }
}

/**
 * Validate individual task structure and detect duplicate references.
 */
function validateTask(task: ConductorTask, taskRefs: Set<string>, workflowName: string): void {
  if (!task.name || typeof task.name !== 'string') {
    throw new ValidationError(
      `Workflow "${workflowName}": task missing required "name" field`
    );
  }

  if (!task.taskReferenceName || typeof task.taskReferenceName !== 'string') {
    throw new ValidationError(
      `Workflow "${workflowName}", task "${task.name}": missing "taskReferenceName"`
    );
  }

  if (!task.type || typeof task.type !== 'string') {
    throw new ValidationError(
      `Workflow "${workflowName}", task "${task.name}": missing "type" field`
    );
  }

  // Check for duplicate task reference names
  if (taskRefs.has(task.taskReferenceName)) {
    throw new ValidationError(
      `Workflow "${workflowName}": duplicate taskReferenceName "${task.taskReferenceName}"`
    );
  }
  taskRefs.add(task.taskReferenceName);

  // Validate nested tasks in DECISION/FORK_JOIN
  if (task.decisionCases) {
    for (const [caseName, caseTasks] of Object.entries(task.decisionCases)) {
      for (const caseTask of caseTasks) {
        validateTask(caseTask, taskRefs, workflowName);
      }
    }
  }

  if (task.forkTasks) {
    for (const branch of task.forkTasks) {
      for (const branchTask of branch) {
        validateTask(branchTask, taskRefs, workflowName);
      }
    }
  }
}
