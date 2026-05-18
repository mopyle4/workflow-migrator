import { ConductorWorkflow } from '../types/conductor';
import * as fs from 'fs';

/**
 * Parse a Netflix Conductor workflow JSON definition
 */
export function parseConductorWorkflow(input: string): ConductorWorkflow {
  let workflow: ConductorWorkflow;

  // Handle file path or raw JSON
  if (fs.existsSync(input)) {
    const content = fs.readFileSync(input, 'utf-8');
    workflow = JSON.parse(content);
  } else {
    workflow = JSON.parse(input);
  }

  // Validate required fields
  if (!workflow.name) {
    throw new Error('Invalid Conductor workflow: missing "name" field');
  }
  if (!workflow.tasks || !Array.isArray(workflow.tasks)) {
    throw new Error('Invalid Conductor workflow: missing or invalid "tasks" array');
  }
  if (workflow.tasks.length === 0) {
    throw new Error('Invalid Conductor workflow: "tasks" array is empty');
  }

  // Validate each task has required fields
  for (const task of workflow.tasks) {
    if (!task.name) {
      throw new Error('Invalid Conductor task: missing "name" field');
    }
    if (!task.taskReferenceName) {
      throw new Error(`Invalid Conductor task "${task.name}": missing "taskReferenceName"`);
    }
    if (!task.type) {
      throw new Error(`Invalid Conductor task "${task.name}": missing "type" field`);
    }
  }

  return workflow;
}
